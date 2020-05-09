"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const URL = require("url");
const fs = require("fs");
const readline = require("readline");
const debug = require("debug");
const removeFolder = require("rimraf");
const childProcess = require("child_process");
const BrowserFetcher_1 = require("./BrowserFetcher");
const Connection_1 = require("./Connection");
const Browser_1 = require("./Browser");
const helper_1 = require("./helper");
const Errors_1 = require("./Errors");
const WebSocketTransport_1 = require("./WebSocketTransport");
const PipeTransport_1 = require("./PipeTransport");
const mkdtempAsync = helper_1.helper.promisify(fs.mkdtemp);
const removeFolderAsync = helper_1.helper.promisify(removeFolder);
const writeFileAsync = helper_1.helper.promisify(fs.writeFile);
const debugLauncher = debug('puppeteer:launcher');
class BrowserRunner {
    constructor(executablePath, processArguments, tempDirectory) {
        this.proc = null;
        this.connection = null;
        this._closed = true;
        this._listeners = [];
        this._executablePath = executablePath;
        this._processArguments = processArguments;
        this._tempDirectory = tempDirectory;
    }
    start(options = {}) {
        const { handleSIGINT, handleSIGTERM, handleSIGHUP, dumpio, env, pipe } = options;
        let stdio = ['pipe', 'pipe', 'pipe'];
        if (pipe) {
            if (dumpio)
                stdio = ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'];
            else
                stdio = ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'];
        }
        helper_1.assert(!this.proc, 'This process has previously been started.');
        debugLauncher(`Calling ${this._executablePath} ${this._processArguments.join(' ')}`);
        this.proc = childProcess.spawn(this._executablePath, this._processArguments, {
            // On non-windows platforms, `detached: true` makes child process a leader of a new
            // process group, making it possible to kill child process tree with `.kill(-pid)` command.
            // @see https://nodejs.org/api/child_process.html#child_process_options_detached
            detached: process.platform !== 'win32',
            env,
            stdio
        });
        if (dumpio) {
            this.proc.stderr.pipe(process.stderr);
            this.proc.stdout.pipe(process.stdout);
        }
        this._closed = false;
        this._processClosing = new Promise(fulfill => {
            this.proc.once('exit', () => {
                this._closed = true;
                // Cleanup as processes exit.
                if (this._tempDirectory) {
                    removeFolderAsync(this._tempDirectory)
                        .then(() => fulfill())
                        .catch(error => console.error(error));
                }
                else {
                    fulfill();
                }
            });
        });
        this._listeners = [helper_1.helper.addEventListener(process, 'exit', this.kill.bind(this))];
        if (handleSIGINT)
            this._listeners.push(helper_1.helper.addEventListener(process, 'SIGINT', () => { this.kill(); process.exit(130); }));
        if (handleSIGTERM)
            this._listeners.push(helper_1.helper.addEventListener(process, 'SIGTERM', this.close.bind(this)));
        if (handleSIGHUP)
            this._listeners.push(helper_1.helper.addEventListener(process, 'SIGHUP', this.close.bind(this)));
    }
    close() {
        if (this._closed)
            return Promise.resolve();
        helper_1.helper.removeEventListeners(this._listeners);
        if (this._tempDirectory) {
            this.kill();
        }
        else if (this.connection) {
            // Attempt to close the browser gracefully
            this.connection.send('Browser.close').catch(error => {
                helper_1.debugError(error);
                this.kill();
            });
        }
        return this._processClosing;
    }
    kill() {
        helper_1.helper.removeEventListeners(this._listeners);
        if (this.proc && this.proc.pid && !this.proc.killed && !this._closed) {
            try {
                if (process.platform === 'win32')
                    childProcess.execSync(`taskkill /pid ${this.proc.pid} /T /F`);
                else
                    process.kill(-this.proc.pid, 'SIGKILL');
            }
            catch (error) {
                // the process might have already stopped
            }
        }
        // Attempt to remove temporary profile directory to avoid littering.
        try {
            removeFolder.sync(this._tempDirectory);
        }
        catch (error) { }
    }
    /**
     * @param {!({usePipe?: boolean, timeout: number, slowMo: number, preferredRevision: string})} options
     *
     * @return {!Promise<!Connection>}
     */
    async setupConnection(options) {
        const { usePipe, timeout, slowMo, preferredRevision } = options;
        if (!usePipe) {
            const browserWSEndpoint = await waitForWSEndpoint(this.proc, timeout, preferredRevision);
            const transport = await WebSocketTransport_1.WebSocketTransport.create(browserWSEndpoint);
            this.connection = new Connection_1.Connection(browserWSEndpoint, transport, slowMo);
        }
        else {
            // stdio was assigned during start(), and the 'pipe' option there adds the 4th and 5th items to stdio array
            const { 3: pipeWrite, 4: pipeRead } = this.proc.stdio;
            const transport = new PipeTransport_1.PipeTransport(pipeWrite, pipeRead);
            this.connection = new Connection_1.Connection('', transport, slowMo);
        }
        return this.connection;
    }
}
class ChromeLauncher {
    constructor(projectRoot, preferredRevision, isPuppeteerCore) {
        this._projectRoot = projectRoot;
        this._preferredRevision = preferredRevision;
        this._isPuppeteerCore = isPuppeteerCore;
    }
    async launch(options = {}) {
        const { ignoreDefaultArgs = false, args = [], dumpio = false, executablePath = null, pipe = false, env = process.env, handleSIGINT = true, handleSIGTERM = true, handleSIGHUP = true, ignoreHTTPSErrors = false, defaultViewport = { width: 800, height: 600 }, slowMo = 0, timeout = 30000 } = options;
        const profilePath = path.join(os.tmpdir(), 'puppeteer_dev_chrome_profile-');
        const chromeArguments = [];
        if (!ignoreDefaultArgs)
            chromeArguments.push(...this.defaultArgs(options));
        else if (Array.isArray(ignoreDefaultArgs))
            chromeArguments.push(...this.defaultArgs(options).filter(arg => !ignoreDefaultArgs.includes(arg)));
        else
            chromeArguments.push(...args);
        let temporaryUserDataDir = null;
        if (!chromeArguments.some(argument => argument.startsWith('--remote-debugging-')))
            chromeArguments.push(pipe ? '--remote-debugging-pipe' : '--remote-debugging-port=0');
        if (!chromeArguments.some(arg => arg.startsWith('--user-data-dir'))) {
            temporaryUserDataDir = await mkdtempAsync(profilePath);
            chromeArguments.push(`--user-data-dir=${temporaryUserDataDir}`);
        }
        let chromeExecutable = executablePath;
        if (!executablePath) {
            const { missingText, executablePath } = resolveExecutablePath(this);
            if (missingText)
                throw new Error(missingText);
            chromeExecutable = executablePath;
        }
        const usePipe = chromeArguments.includes('--remote-debugging-pipe');
        const runner = new BrowserRunner(chromeExecutable, chromeArguments, temporaryUserDataDir);
        runner.start({ handleSIGHUP, handleSIGTERM, handleSIGINT, dumpio, env, pipe: usePipe });
        try {
            const connection = await runner.setupConnection({ usePipe, timeout, slowMo, preferredRevision: this._preferredRevision });
            const browser = await Browser_1.Browser.create(connection, [], ignoreHTTPSErrors, defaultViewport, runner.proc, runner.close.bind(runner));
            await browser.waitForTarget(t => t.type() === 'page');
            return browser;
        }
        catch (error) {
            runner.kill();
            throw error;
        }
    }
    /**
     * @param {!Launcher.ChromeArgOptions=} options
     * @return {!Array<string>}
     */
    defaultArgs(options = {}) {
        const chromeArguments = [
            '--disable-background-networking',
            '--enable-features=NetworkService,NetworkServiceInProcess',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-client-side-phishing-detection',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-features=TranslateUI',
            '--disable-hang-monitor',
            '--disable-ipc-flooding-protection',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-renderer-backgrounding',
            '--disable-sync',
            '--force-color-profile=srgb',
            '--metrics-recording-only',
            '--no-first-run',
            '--enable-automation',
            '--password-store=basic',
            '--use-mock-keychain',
        ];
        const { devtools = false, headless = !devtools, args = [], userDataDir = null } = options;
        if (userDataDir)
            chromeArguments.push(`--user-data-dir=${userDataDir}`);
        if (devtools)
            chromeArguments.push('--auto-open-devtools-for-tabs');
        if (headless) {
            chromeArguments.push('--headless', '--hide-scrollbars', '--mute-audio');
        }
        if (args.every(arg => arg.startsWith('-')))
            chromeArguments.push('about:blank');
        chromeArguments.push(...args);
        return chromeArguments;
    }
    executablePath() {
        return resolveExecutablePath(this).executablePath;
    }
    get product() {
        return 'chrome';
    }
    async connect(options) {
        const { browserWSEndpoint, browserURL, ignoreHTTPSErrors = false, defaultViewport = { width: 800, height: 600 }, transport, slowMo = 0, } = options;
        helper_1.assert(Number(!!browserWSEndpoint) + Number(!!browserURL) + Number(!!transport) === 1, 'Exactly one of browserWSEndpoint, browserURL or transport must be passed to puppeteer.connect');
        let connection = null;
        if (transport) {
            connection = new Connection_1.Connection('', transport, slowMo);
        }
        else if (browserWSEndpoint) {
            const connectionTransport = await WebSocketTransport_1.WebSocketTransport.create(browserWSEndpoint);
            connection = new Connection_1.Connection(browserWSEndpoint, connectionTransport, slowMo);
        }
        else if (browserURL) {
            const connectionURL = await getWSEndpoint(browserURL);
            const connectionTransport = await WebSocketTransport_1.WebSocketTransport.create(connectionURL);
            connection = new Connection_1.Connection(connectionURL, connectionTransport, slowMo);
        }
        const { browserContextIds } = await connection.send('Target.getBrowserContexts');
        return Browser_1.Browser.create(connection, browserContextIds, ignoreHTTPSErrors, defaultViewport, null, () => connection.send('Browser.close').catch(helper_1.debugError));
    }
}
class FirefoxLauncher {
    constructor(projectRoot, preferredRevision, isPuppeteerCore) {
        this._projectRoot = projectRoot;
        this._preferredRevision = preferredRevision;
        this._isPuppeteerCore = isPuppeteerCore;
    }
    async launch(options = {}) {
        const { ignoreDefaultArgs = false, args = [], dumpio = false, executablePath = null, pipe = false, env = process.env, handleSIGINT = true, handleSIGTERM = true, handleSIGHUP = true, ignoreHTTPSErrors = false, defaultViewport = { width: 800, height: 600 }, slowMo = 0, timeout = 30000, extraPrefsFirefox = {} } = options;
        const firefoxArguments = [];
        if (!ignoreDefaultArgs)
            firefoxArguments.push(...this.defaultArgs(options));
        else if (Array.isArray(ignoreDefaultArgs))
            firefoxArguments.push(...this.defaultArgs(options).filter(arg => !ignoreDefaultArgs.includes(arg)));
        else
            firefoxArguments.push(...args);
        if (!firefoxArguments.some(argument => argument.startsWith('--remote-debugging-')))
            firefoxArguments.push('--remote-debugging-port=0');
        let temporaryUserDataDir = null;
        if (!firefoxArguments.includes('-profile') && !firefoxArguments.includes('--profile')) {
            temporaryUserDataDir = await this._createProfile(extraPrefsFirefox);
            firefoxArguments.push('--profile');
            firefoxArguments.push(temporaryUserDataDir);
        }
        await this._updateRevision();
        let firefoxExecutable = executablePath;
        if (!executablePath) {
            const { missingText, executablePath } = resolveExecutablePath(this);
            if (missingText)
                throw new Error(missingText);
            firefoxExecutable = executablePath;
        }
        const runner = new BrowserRunner(firefoxExecutable, firefoxArguments, temporaryUserDataDir);
        runner.start({ handleSIGHUP, handleSIGTERM, handleSIGINT, dumpio, env, pipe });
        try {
            const connection = await runner.setupConnection({ usePipe: pipe, timeout, slowMo, preferredRevision: this._preferredRevision });
            const browser = await Browser_1.Browser.create(connection, [], ignoreHTTPSErrors, defaultViewport, runner.proc, runner.close.bind(runner));
            await browser.waitForTarget(t => t.type() === 'page');
            return browser;
        }
        catch (error) {
            runner.kill();
            throw error;
        }
    }
    async connect(options) {
        const { browserWSEndpoint, browserURL, ignoreHTTPSErrors = false, defaultViewport = { width: 800, height: 600 }, transport, slowMo = 0, } = options;
        helper_1.assert(Number(!!browserWSEndpoint) + Number(!!browserURL) + Number(!!transport) === 1, 'Exactly one of browserWSEndpoint, browserURL or transport must be passed to puppeteer.connect');
        let connection = null;
        if (transport) {
            connection = new Connection_1.Connection('', transport, slowMo);
        }
        else if (browserWSEndpoint) {
            const connectionTransport = await WebSocketTransport_1.WebSocketTransport.create(browserWSEndpoint);
            connection = new Connection_1.Connection(browserWSEndpoint, connectionTransport, slowMo);
        }
        else if (browserURL) {
            const connectionURL = await getWSEndpoint(browserURL);
            const connectionTransport = await WebSocketTransport_1.WebSocketTransport.create(connectionURL);
            connection = new Connection_1.Connection(connectionURL, connectionTransport, slowMo);
        }
        const { browserContextIds } = await connection.send('Target.getBrowserContexts');
        return Browser_1.Browser.create(connection, browserContextIds, ignoreHTTPSErrors, defaultViewport, null, () => connection.send('Browser.close').catch(helper_1.debugError));
    }
    executablePath() {
        return resolveExecutablePath(this).executablePath;
    }
    async _updateRevision() {
        // replace 'latest' placeholder with actual downloaded revision
        if (this._preferredRevision === 'latest') {
            const browserFetcher = new BrowserFetcher_1.BrowserFetcher(this._projectRoot, { product: this.product });
            const localRevisions = await browserFetcher.localRevisions();
            if (localRevisions[0])
                this._preferredRevision = localRevisions[0];
        }
    }
    get product() {
        return 'firefox';
    }
    defaultArgs(options = {}) {
        const firefoxArguments = [
            '--no-remote',
            '--foreground',
        ];
        const { devtools = false, headless = !devtools, args = [], userDataDir = null } = options;
        if (userDataDir) {
            firefoxArguments.push('--profile');
            firefoxArguments.push(userDataDir);
        }
        if (headless)
            firefoxArguments.push('--headless');
        if (devtools)
            firefoxArguments.push('--devtools');
        if (args.every(arg => arg.startsWith('-')))
            firefoxArguments.push('about:blank');
        firefoxArguments.push(...args);
        return firefoxArguments;
    }
    async _createProfile(extraPrefs) {
        const profilePath = await mkdtempAsync(path.join(os.tmpdir(), 'puppeteer_dev_firefox_profile-'));
        const prefsJS = [];
        const userJS = [];
        const server = 'dummy.test';
        const defaultPreferences = {
            // Make sure Shield doesn't hit the network.
            'app.normandy.api_url': '',
            // Disable Firefox old build background check
            'app.update.checkInstallTime': false,
            // Disable automatically upgrading Firefox
            'app.update.disabledForTesting': true,
            // Increase the APZ content response timeout to 1 minute
            'apz.content_response_timeout': 60000,
            // Prevent various error message on the console
            // jest-puppeteer asserts that no error message is emitted by the console
            'browser.contentblocking.features.standard': '-tp,tpPrivate,cookieBehavior0,-cm,-fp',
            // Enable the dump function: which sends messages to the system
            // console
            // https://bugzilla.mozilla.org/show_bug.cgi?id=1543115
            'browser.dom.window.dump.enabled': true,
            // Disable topstories
            'browser.newtabpage.activity-stream.feeds.section.topstories': false,
            // Always display a blank page
            'browser.newtabpage.enabled': false,
            // Background thumbnails in particular cause grief: and disabling
            // thumbnails in general cannot hurt
            'browser.pagethumbnails.capturing_disabled': true,
            // Disable safebrowsing components.
            'browser.safebrowsing.blockedURIs.enabled': false,
            'browser.safebrowsing.downloads.enabled': false,
            'browser.safebrowsing.malware.enabled': false,
            'browser.safebrowsing.passwords.enabled': false,
            'browser.safebrowsing.phishing.enabled': false,
            // Disable updates to search engines.
            'browser.search.update': false,
            // Do not restore the last open set of tabs if the browser has crashed
            'browser.sessionstore.resume_from_crash': false,
            // Skip check for default browser on startup
            'browser.shell.checkDefaultBrowser': false,
            // Disable newtabpage
            'browser.startup.homepage': 'about:blank',
            // Do not redirect user when a milstone upgrade of Firefox is detected
            'browser.startup.homepage_override.mstone': 'ignore',
            // Start with a blank page about:blank
            'browser.startup.page': 0,
            // Do not allow background tabs to be zombified on Android: otherwise for
            // tests that open additional tabs: the test harness tab itself might get
            // unloaded
            'browser.tabs.disableBackgroundZombification': false,
            // Do not warn when closing all other open tabs
            'browser.tabs.warnOnCloseOtherTabs': false,
            // Do not warn when multiple tabs will be opened
            'browser.tabs.warnOnOpen': false,
            // Disable the UI tour.
            'browser.uitour.enabled': false,
            // Turn off search suggestions in the location bar so as not to trigger
            // network connections.
            'browser.urlbar.suggest.searches': false,
            // Disable first run splash page on Windows 10
            'browser.usedOnWindows10.introURL': '',
            // Do not warn on quitting Firefox
            'browser.warnOnQuit': false,
            // Do not show datareporting policy notifications which can
            // interfere with tests
            'datareporting.healthreport.about.reportUrl': `http://${server}/dummy/abouthealthreport/`,
            'datareporting.healthreport.documentServerURI': `http://${server}/dummy/healthreport/`,
            'datareporting.healthreport.logging.consoleEnabled': false,
            'datareporting.healthreport.service.enabled': false,
            'datareporting.healthreport.service.firstRun': false,
            'datareporting.healthreport.uploadEnabled': false,
            'datareporting.policy.dataSubmissionEnabled': false,
            'datareporting.policy.dataSubmissionPolicyAccepted': false,
            'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
            // DevTools JSONViewer sometimes fails to load dependencies with its require.js.
            // This doesn't affect Puppeteer but spams console (Bug 1424372)
            'devtools.jsonview.enabled': false,
            // Disable popup-blocker
            'dom.disable_open_during_load': false,
            // Enable the support for File object creation in the content process
            // Required for |Page.setFileInputFiles| protocol method.
            'dom.file.createInChild': true,
            // Disable the ProcessHangMonitor
            'dom.ipc.reportProcessHangs': false,
            // Disable slow script dialogues
            'dom.max_chrome_script_run_time': 0,
            'dom.max_script_run_time': 0,
            // Only load extensions from the application and user profile
            // AddonManager.SCOPE_PROFILE + AddonManager.SCOPE_APPLICATION
            'extensions.autoDisableScopes': 0,
            'extensions.enabledScopes': 5,
            // Disable metadata caching for installed add-ons by default
            'extensions.getAddons.cache.enabled': false,
            // Disable installing any distribution extensions or add-ons.
            'extensions.installDistroAddons': false,
            // Disabled screenshots extension
            'extensions.screenshots.disabled': true,
            // Turn off extension updates so they do not bother tests
            'extensions.update.enabled': false,
            // Turn off extension updates so they do not bother tests
            'extensions.update.notifyUser': false,
            // Make sure opening about:addons will not hit the network
            'extensions.webservice.discoverURL': `http://${server}/dummy/discoveryURL`,
            // Allow the application to have focus even it runs in the background
            'focusmanager.testmode': true,
            // Disable useragent updates
            'general.useragent.updates.enabled': false,
            // Always use network provider for geolocation tests so we bypass the
            // macOS dialog raised by the corelocation provider
            'geo.provider.testing': true,
            // Do not scan Wifi
            'geo.wifi.scan': false,
            // No hang monitor
            'hangmonitor.timeout': 0,
            // Show chrome errors and warnings in the error console
            'javascript.options.showInConsole': true,
            // Disable download and usage of OpenH264: and Widevine plugins
            'media.gmp-manager.updateEnabled': false,
            // Prevent various error message on the console
            // jest-puppeteer asserts that no error message is emitted by the console
            'network.cookie.cookieBehavior': 0,
            // Do not prompt for temporary redirects
            'network.http.prompt-temp-redirect': false,
            // Disable speculative connections so they are not reported as leaking
            // when they are hanging around
            'network.http.speculative-parallel-limit': 0,
            // Do not automatically switch between offline and online
            'network.manage-offline-status': false,
            // Make sure SNTP requests do not hit the network
            'network.sntp.pools': server,
            // Disable Flash.
            'plugin.state.flash': 0,
            'privacy.trackingprotection.enabled': false,
            // Enable Remote Agent
            // https://bugzilla.mozilla.org/show_bug.cgi?id=1544393
            'remote.enabled': true,
            // Don't do network connections for mitm priming
            'security.certerrors.mitm.priming.enabled': false,
            // Local documents have access to all other local documents,
            // including directory listings
            'security.fileuri.strict_origin_policy': false,
            // Do not wait for the notification button security delay
            'security.notification_enable_delay': 0,
            // Ensure blocklist updates do not hit the network
            'services.settings.server': `http://${server}/dummy/blocklist/`,
            // Do not automatically fill sign-in forms with known usernames and
            // passwords
            'signon.autofillForms': false,
            // Disable password capture, so that tests that include forms are not
            // influenced by the presence of the persistent doorhanger notification
            'signon.rememberSignons': false,
            // Disable first-run welcome page
            'startup.homepage_welcome_url': 'about:blank',
            // Disable first-run welcome page
            'startup.homepage_welcome_url.additional': '',
            // Disable browser animations (tabs, fullscreen, sliding alerts)
            'toolkit.cosmeticAnimations.enabled': false,
            // We want to collect telemetry, but we don't want to send in the results
            'toolkit.telemetry.server': `https://${server}/dummy/telemetry/`,
            // Prevent starting into safe mode after application crashes
            'toolkit.startup.max_resumed_crashes': -1,
        };
        Object.assign(defaultPreferences, extraPrefs);
        for (const [key, value] of Object.entries(defaultPreferences))
            userJS.push(`user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
        await writeFileAsync(path.join(profilePath, 'user.js'), userJS.join('\n'));
        await writeFileAsync(path.join(profilePath, 'prefs.js'), prefsJS.join('\n'));
        return profilePath;
    }
}
function waitForWSEndpoint(browserProcess, timeout, preferredRevision) {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({ input: browserProcess.stderr });
        let stderr = '';
        const listeners = [
            helper_1.helper.addEventListener(rl, 'line', onLine),
            helper_1.helper.addEventListener(rl, 'close', () => onClose()),
            helper_1.helper.addEventListener(browserProcess, 'exit', () => onClose()),
            helper_1.helper.addEventListener(browserProcess, 'error', error => onClose(error))
        ];
        const timeoutId = timeout ? setTimeout(onTimeout, timeout) : 0;
        /**
         * @param {!Error=} error
         */
        function onClose(error) {
            cleanup();
            reject(new Error([
                'Failed to launch the browser process!' + (error ? ' ' + error.message : ''),
                stderr,
                '',
                'TROUBLESHOOTING: https://github.com/puppeteer/puppeteer/blob/master/docs/troubleshooting.md',
                '',
            ].join('\n')));
        }
        function onTimeout() {
            cleanup();
            reject(new Errors_1.TimeoutError(`Timed out after ${timeout} ms while trying to connect to the browser! Only Chrome at revision r${preferredRevision} is guaranteed to work.`));
        }
        function onLine(line) {
            stderr += line + '\n';
            const match = line.match(/^DevTools listening on (ws:\/\/.*)$/);
            if (!match)
                return;
            cleanup();
            resolve(match[1]);
        }
        function cleanup() {
            if (timeoutId)
                clearTimeout(timeoutId);
            helper_1.helper.removeEventListeners(listeners);
        }
    });
}
function getWSEndpoint(browserURL) {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const endpointURL = URL.resolve(browserURL, '/json/version');
    const protocol = endpointURL.startsWith('https') ? https : http;
    const requestOptions = Object.assign(URL.parse(endpointURL), { method: 'GET' });
    const request = protocol.request(requestOptions, res => {
        let data = '';
        if (res.statusCode !== 200) {
            // Consume response data to free up memory.
            res.resume();
            reject(new Error('HTTP ' + res.statusCode));
            return;
        }
        res.setEncoding('utf8');
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data).webSocketDebuggerUrl));
    });
    request.on('error', reject);
    request.end();
    return promise.catch(error => {
        error.message = `Failed to fetch browser webSocket url from ${endpointURL}: ` + error.message;
        throw error;
    });
}
function resolveExecutablePath(launcher) {
    // puppeteer-core doesn't take into account PUPPETEER_* env variables.
    if (!launcher._isPuppeteerCore) {
        const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.npm_config_puppeteer_executable_path || process.env.npm_package_config_puppeteer_executable_path;
        if (executablePath) {
            const missingText = !fs.existsSync(executablePath) ? 'Tried to use PUPPETEER_EXECUTABLE_PATH env variable to launch browser but did not find any executable at: ' + executablePath : null;
            return { executablePath, missingText };
        }
    }
    const browserFetcher = new BrowserFetcher_1.BrowserFetcher(launcher._projectRoot, { product: launcher.product });
    if (!launcher._isPuppeteerCore && launcher.product === 'chrome') {
        const revision = process.env['PUPPETEER_CHROMIUM_REVISION'];
        if (revision) {
            const revisionInfo = browserFetcher.revisionInfo(revision);
            const missingText = !revisionInfo.local ? 'Tried to use PUPPETEER_CHROMIUM_REVISION env variable to launch browser but did not find executable at: ' + revisionInfo.executablePath : null;
            return { executablePath: revisionInfo.executablePath, missingText };
        }
    }
    const revisionInfo = browserFetcher.revisionInfo(launcher._preferredRevision);
    const missingText = !revisionInfo.local ? `Could not find browser revision ${launcher._preferredRevision}. Run "npm install" or "yarn install" to download a browser binary.` : null;
    return { executablePath: revisionInfo.executablePath, missingText };
}
function Launcher(projectRoot, preferredRevision, isPuppeteerCore, product) {
    // puppeteer-core doesn't take into account PUPPETEER_* env variables.
    if (!product && !isPuppeteerCore)
        product = process.env.PUPPETEER_PRODUCT || process.env.npm_config_puppeteer_product || process.env.npm_package_config_puppeteer_product;
    switch (product) {
        case 'firefox':
            return new FirefoxLauncher(projectRoot, preferredRevision, isPuppeteerCore);
        case 'chrome':
        default:
            return new ChromeLauncher(projectRoot, preferredRevision, isPuppeteerCore);
    }
}
exports.default = Launcher;

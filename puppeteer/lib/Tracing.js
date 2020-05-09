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
const helper_1 = require("./helper");
class Tracing {
    constructor(client) {
        this._recording = false;
        this._path = '';
        this._client = client;
    }
    async start(options = {}) {
        helper_1.assert(!this._recording, 'Cannot start recording trace while already recording trace.');
        const defaultCategories = [
            '-*', 'devtools.timeline', 'v8.execute', 'disabled-by-default-devtools.timeline',
            'disabled-by-default-devtools.timeline.frame', 'toplevel',
            'blink.console', 'blink.user_timing', 'latencyInfo', 'disabled-by-default-devtools.timeline.stack',
            'disabled-by-default-v8.cpu_profiler', 'disabled-by-default-v8.cpu_profiler.hires'
        ];
        const { path = null, screenshots = false, categories = defaultCategories, } = options;
        if (screenshots)
            categories.push('disabled-by-default-devtools.screenshot');
        this._path = path;
        this._recording = true;
        await this._client.send('Tracing.start', {
            transferMode: 'ReturnAsStream',
            categories: categories.join(',')
        });
    }
    async stop() {
        let fulfill;
        const contentPromise = new Promise(x => fulfill = x);
        this._client.once('Tracing.tracingComplete', event => {
            helper_1.helper.readProtocolStream(this._client, event.stream, this._path).then(fulfill);
        });
        await this._client.send('Tracing.end');
        this._recording = false;
        return contentPromise;
    }
}
exports.Tracing = Tracing;

// Copyright 2016 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/**
 * @constructor
 * @implements {WebInspector.OutputStream}
 * @param {!WebInspector.TimelineModel} model
 * @param {!WebInspector.Progress} progress
 * @param {function()=} canceledCallback
 */
WebInspector.TimelineLoader = function(model, progress, canceledCallback)
{
    this._model = model;

    this._canceledCallback = canceledCallback;
    this._progress = progress;
    this._progress.setTitle(WebInspector.UIString("Loading"));
    this._progress.setTotalWork(WebInspector.TimelineLoader._totalProgress);  // Unknown, will loop the values.

    this._state = WebInspector.TimelineLoader.State.Initial;
    this._buffer = "";
    this._firstChunk = true;
    this._wasCanceledOnce = false;

    this._loadedBytes = 0;
    this._jsonTokenizer = new WebInspector.TextUtils.BalancedJSONTokenizer(this._writeBalancedJSON.bind(this), true);
}

/**
 * @param {!WebInspector.TimelineModel} model
 * @param {!File} file
 * @param {!WebInspector.Progress} progress
 */
WebInspector.TimelineLoader.loadFromFile = function(model, file, progress)
{
    var delegate = new WebInspector.TimelineModelLoadFromFileDelegate(model, progress);
    var fileReader = WebInspector.TimelineLoader._createFileReader(file, delegate);
    var loader = new WebInspector.TimelineLoader(model, new WebInspector.ProgressProxy(null), fileReader.cancel.bind(fileReader));
    fileReader.start(loader);
}

/**
 * @param {!WebInspector.TimelineModel} model
 * @param {string} url
 * @param {!WebInspector.Progress} progress
 */
WebInspector.TimelineLoader.loadFromURL = function(model, url, progress)
{
    var stream = new WebInspector.TimelineLoader(model, progress);
    WebInspector.ResourceLoader.loadAsStream(url, null, stream);
}

/**
 * @param {!File} file
 * @param {!WebInspector.OutputStreamDelegate} delegate
 * @return {!WebInspector.ChunkedReader}
 */
WebInspector.TimelineLoader._createFileReader = function(file, delegate)
{
    return new WebInspector.ChunkedFileReader(file, WebInspector.TimelineModel.TransferChunkLengthBytes, delegate);
}


WebInspector.TimelineLoader._totalProgress = 100000;

WebInspector.TimelineLoader.State = {
    Initial: "Initial",
    LookingForEvents: "LookingForEvents",
    ReadingEvents: "ReadingEvents"
}

WebInspector.TimelineLoader.prototype = {
    /**
     * @override
     * @param {string} chunk
     */
    write: function(chunk)
    {
        this._loadedBytes += chunk.length;
        if (this._progress.isCanceled() && !this._wasCanceledOnce) {
            this._wasCanceled = true;
            this._reportErrorAndCancelLoading();
            return;
        }
        this._progress.setWorked(this._loadedBytes % WebInspector.TimelineLoader._totalProgress,
                                 WebInspector.UIString("Loaded %s", Number.bytesToString(this._loadedBytes)));
        if (this._state === WebInspector.TimelineLoader.State.Initial) {
            if (chunk[0] === "{")
                this._state = WebInspector.TimelineLoader.State.LookingForEvents;
            else if (chunk[0] === "[")
                this._state = WebInspector.TimelineLoader.State.ReadingEvents;
            else {
                this._reportErrorAndCancelLoading(WebInspector.UIString("Malformed timeline data: Unknown JSON format"));
                return;
            }
        }

        if (this._state === WebInspector.TimelineLoader.State.LookingForEvents) {
            var objectName = "\"traceEvents\":";
            var startPos = this._buffer.length - objectName.length;
            this._buffer += chunk;
            var pos = this._buffer.indexOf(objectName, startPos);
            if (pos === -1)
                return;
            chunk = this._buffer.slice(pos + objectName.length)
            this._state = WebInspector.TimelineLoader.State.ReadingEvents;
        }

        this._jsonTokenizer.write(chunk);
    },

    /**
     * @param {string} data
     */
    _writeBalancedJSON: function(data)
    {
        var json = data + "]";

        if (this._firstChunk) {
            this._model.startCollectingTraceEvents(true);
        } else {
            var commaIndex = json.indexOf(",");
            if (commaIndex !== -1)
                json = json.slice(commaIndex + 1);
            json = "[" + json;
        }

        var items;
        try {
            items = /** @type {!Array.<!WebInspector.TracingManager.EventPayload>} */ (JSON.parse(json));
        } catch (e) {
            this._reportErrorAndCancelLoading(WebInspector.UIString("Malformed timeline data: %s", e.toString()));
            return;
        }

        if (this._firstChunk) {
            this._firstChunk = false;
            if (this._looksLikeAppVersion(items[0])) {
                this._reportErrorAndCancelLoading(WebInspector.UIString("Legacy Timeline format is not supported."));
                return;
            }
        }

        try {
            this._model.traceEventsCollected(items);
        } catch(e) {
            this._reportErrorAndCancelLoading(WebInspector.UIString("Malformed timeline data: %s", e.toString()));
            return;
        }
    },

    /**
     * @param {string=} message
     */
    _reportErrorAndCancelLoading: function(message)
    {
        if (message)
            WebInspector.console.error(message);
        this._model.tracingComplete();
        this._model.reset();
        if (this._canceledCallback)
            this._canceledCallback();
        this._progress.done();
    },

    /**
     * @param {*} item
     * @return {boolean}
     */
    _looksLikeAppVersion: function(item)
    {
        return typeof item === "string" && item.indexOf("Chrome") !== -1;
    },

    /**
     * @override
     */
    close: function()
    {
        this._model._loadedFromFile = true;
        this._model.tracingComplete();
        if (this._progress)
            this._progress.done();
    }
}

/**
 * @constructor
 * @implements {WebInspector.OutputStreamDelegate}
 * @param {!WebInspector.TimelineModel} model
 * @param {!WebInspector.Progress} progress
 */
WebInspector.TimelineModelLoadFromFileDelegate = function(model, progress)
{
    this._model = model;
    this._progress = progress;
}

WebInspector.TimelineModelLoadFromFileDelegate.prototype = {
    /**
     * @override
     */
    onTransferStarted: function()
    {
        this._progress.setTitle(WebInspector.UIString("Loading\u2026"));
    },

    /**
     * @override
     * @param {!WebInspector.ChunkedReader} reader
     */
    onChunkTransferred: function(reader)
    {
        if (this._progress.isCanceled()) {
            reader.cancel();
            this._progress.done();
            this._model.reset();
            return;
        }

        var totalSize = reader.fileSize();
        if (totalSize) {
            this._progress.setTotalWork(totalSize);
            this._progress.setWorked(reader.loadedSize());
        }
    },

    /**
     * @override
     */
    onTransferFinished: function()
    {
        this._progress.done();
    },

    /**
     * @override
     * @param {!WebInspector.ChunkedReader} reader
     * @param {!Event} event
     */
    onError: function(reader, event)
    {
        this._progress.done();
        this._model.reset();
        switch (event.target.error.code) {
        case FileError.NOT_FOUND_ERR:
            WebInspector.console.error(WebInspector.UIString("File \"%s\" not found.", reader.fileName()));
            break;
        case FileError.NOT_READABLE_ERR:
            WebInspector.console.error(WebInspector.UIString("File \"%s\" is not readable", reader.fileName()));
            break;
        case FileError.ABORT_ERR:
            break;
        default:
            WebInspector.console.error(WebInspector.UIString("An error occurred while reading the file \"%s\"", reader.fileName()));
        }
    }
}

/**
 * @constructor
 * @param {!WebInspector.OutputStream} stream
 * @implements {WebInspector.OutputStreamDelegate}
 */
WebInspector.TracingTimelineSaver = function(stream)
{
    this._stream = stream;
}

WebInspector.TracingTimelineSaver.prototype = {
    /**
     * @override
     */
    onTransferStarted: function()
    {
        this._stream.write("[");
    },

    /**
     * @override
     */
    onTransferFinished: function()
    {
        this._stream.write("]");
    },

    /**
     * @override
     * @param {!WebInspector.ChunkedReader} reader
     */
    onChunkTransferred: function(reader) { },

    /**
     * @override
     * @param {!WebInspector.ChunkedReader} reader
     * @param {!Event} event
     */
    onError: function(reader, event) { }
}
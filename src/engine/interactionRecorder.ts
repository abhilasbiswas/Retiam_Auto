// @ts-nocheck
// ==========================================
// Interaction Recording & Playback System
// ==========================================

export class InteractionRecorder {
    constructor() {
        this.isRecording = false;
        this.events = [];
        this.startClock = 0;
    }

    startRecording(clock) {
        this.isRecording = true;
        this.events = [];
        this.startClock = clock;
        console.log(`⏺ Recording started at t=${clock.toFixed(2)}s`);
    }

    stopRecording() {
        this.isRecording = false;
        const duration = this.events.length > 0
            ? this.events[this.events.length - 1].t - this.events[0].t
            : 0;
        console.log(`⏹ Recording stopped. ${this.events.length} events, ${duration.toFixed(2)}s`);
    }

    captureEvent(type, clock, objectName = null, point = null, ray = null) {
        if (!this.isRecording) return;
        const evt = { t: clock, type };
        if (objectName) evt.objectName = objectName;
        if (point) evt.point = [...point];
        if (ray) evt.ray = [...ray];
        this.events.push(evt);
    }

    getRecording() {
        return {
            version: 1,
            startClock: this.startClock,
            duration: this.events.length > 0
                ? this.events[this.events.length - 1].t - this.events[0].t
                : 0,
            eventCount: this.events.length,
            events: this.events
        };
    }

    exportJSON() {
        const data = this.getRecording();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `interaction_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    }
}

export class InteractionPlayer {
    constructor() {
        this.name = 'Track';
        this.isEnabled = true;
        this.recording = null;
        this.playbackHead = 0; // index into event array
        this.lastClock = 0;
        this.isPlaying = false;
        this._activeObject = null; // currently "dragging" object ref
    }

    loadRecording(json) {
        if (typeof json === 'string') json = JSON.parse(json);
        this.recording = json;
        this.reset();
        console.log(`📂 Loaded recording: ${json.eventCount} events, ${json.duration.toFixed(2)}s`);
    }

    reset() {
        this.playbackHead = 0;
        this.lastClock = 0;
        this._activeObject = null;
        this.isPlaying = true;
    }

    clear() {
        this.recording = null;
        this.playbackHead = 0;
        this.lastClock = 0;
        this.isPlaying = false;
        this._activeObject = null;
    }

    _findObject(name, mobjects) {
        for (let m of mobjects) {
            if (m.name === name) return m;
            if (m.children) {
                for (let c of m.children) {
                    if (c.name === name) return c;
                }
            }
        }
        return null;
    }

    applyEventsForTime(clock, mobjects) {
        if (!this.recording || !this.isPlaying) return false;

        const events = this.recording.events;
        let anyFired = false;

        // Process all events between lastClock and current clock
        while (this.playbackHead < events.length && events[this.playbackHead].t <= clock) {
            const evt = events[this.playbackHead];
            this.playbackHead++;

            if (evt.type === 'mousedown') {
                const obj = this._findObject(evt.objectName, mobjects);
                if (obj && obj.onMouseDown) {
                    const consumed = obj.onMouseDown(evt.point, evt.ray);
                    if (consumed !== false) {
                        this._activeObject = obj;
                    }
                    anyFired = true;
                }
            } else if (evt.type === 'mousemove') {
                if (this._activeObject && this._activeObject.onMouseDrag) {
                    this._activeObject.onMouseDrag(evt.point, evt.ray, 0);
                    anyFired = true;
                }
            } else if (evt.type === 'mouseup') {
                if (this._activeObject && this._activeObject.onMouseUp) {
                    this._activeObject.onMouseUp();
                }
                this._activeObject = null;
                anyFired = true;
            }
        }

        // Check if we've reached the end
        if (this.playbackHead >= events.length) {
            this.isPlaying = false;
            this._activeObject = null;
        }

        this.lastClock = clock;
        return anyFired;
    }
}

export class InteractionManager {
    constructor() {
        this.tracks = []; // Array of InteractionPlayer
        this.recorder = new InteractionRecorder();
        this.isRecording = false;
        this.isPlaying = false;
    }

    startRecording(clock) {
        this.isRecording = true;
        this.recorder.startRecording(clock);
        
        // Reset and play all enabled tracks to allow mixing
        this.tracks.forEach(track => {
            if (track.isEnabled) track.reset();
        });
        this.isPlaying = true;
    }

    stopRecording() {
        this.isRecording = false;
        this.recorder.stopRecording();
        const recData = this.recorder.getRecording();
        if (recData.events.length > 0) {
            const newTrack = new InteractionPlayer();
            newTrack.loadRecording(recData);
            newTrack.name = `Track ${this.tracks.length + 1}`;
            this.tracks.push(newTrack);
        }
        this.isPlaying = false;
    }

    play() {
        this.isPlaying = true;
        this.tracks.forEach(t => { if (t.isEnabled) t.reset(); });
    }

    stop() {
        this.isPlaying = false;
        this.tracks.forEach(t => t.isPlaying = false);
    }

    applyEventsForTime(clock, mobjects) {
        if (!this.isPlaying) return false;
        let anyFired = false;
        for (let track of this.tracks) {
            if (track.isEnabled && track.applyEventsForTime(clock, mobjects)) {
                anyFired = true;
            }
        }
        return anyFired;
    }

    clear() {
        this.tracks = [];
        this.stop();
    }

    exportAll() {
        if (this.tracks.length === 0) return;
        const exportData = {
            version: 2,
            tracks: this.tracks.map(t => ({
                name: t.name,
                isEnabled: t.isEnabled,
                recording: t.recording
            }))
        };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `interactions_bundle_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    loadAll(jsonStr) {
        let data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        if (data.version === 2 && data.tracks) {
            data.tracks.forEach(td => {
                const p = new InteractionPlayer();
                p.loadRecording(td.recording);
                p.name = td.name || `Track ${this.tracks.length + 1}`;
                p.isEnabled = td.isEnabled !== undefined ? td.isEnabled : true;
                this.tracks.push(p);
            });
        } else {
            // Legacy v1 single track
            const p = new InteractionPlayer();
            p.loadRecording(data);
            p.name = `Legacy Track ${this.tracks.length + 1}`;
            this.tracks.push(p);
        }
    }
}

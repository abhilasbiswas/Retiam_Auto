// @ts-nocheck
import { Math3D } from "../math/math3d";
import { RenderEngine } from "../engine/renderEngine";
import { CameraController } from "../engine/camera";
import { Mobject, Material, MeshObject, Group, Sphere, ValueTracker, globalVectorAtlas, VideoObject } from "./mobjects";
import { Animation, Create, FadeIn, FadeOut, MoveCamera, Indicate } from "./animations";
import { populateSceneGraph, drawGimbal } from "../ui/sceneGraph";
import { rate_functions } from "../math/rate_functions";
import { OIDNManager } from "../gpu/oidnManager";
import { InteractionManager } from "../engine/interactionRecorder";

export class Scene {
    constructor() {
        this.mobjects = [];
        this.activeAnimations = [];
        const p = Math3D.vec3(0, 3, 10); const target = Math3D.vec3(0, 1.5, 0);
        const dir = Math3D.normalize(Math3D.sub(target, p));
        const right = Math3D.normalize(Math3D.cross(dir, Math3D.vec3(0, 1, 0)));

        this.camera = {
            pos: p, dir: dir, right: right, up: Math3D.cross(right, dir),
            fov: Math.PI / 4, aperture: 0.10, focusDist: Math3D.length(Math3D.sub(target, p)),
            samplesPerFrame: 1, bounces: 5, model: 0,
            skyColor: [0.1, 0.2, 0.35], skyIntensity: 1.0, giMultiplier: 1.0,
            orthoScale: 10.0, lensShiftX: 0.0, lensShiftY: 0.0 // <-- Added properties
        };

        this.lastTime = performance.now();
        this.frameCount = 0;
        this.clock = 0;
        window.isRenderingVideo = false;

        this.isPlaying = true;
        this.isLooping = false;
        this.loopStart = 0.0;
        this.loopEnd = 15.0;
        this.playbackSpeed = 1.0;
    }

    async play(...animations) {
        animations = animations.map(a => a.build ? a.build() : a);
        animations.forEach(a => {
            a.scene = this;
            if (a.introducer && !this.mobjects.includes(a.mobject)) this.add(a.mobject);
            a.begin();
        });
        return new Promise(resolve => this.activeAnimations.push({ animations, resolve }));
    }

    async wait(duration = 1.0) {
        return new Promise(resolve => this.activeAnimations.push({ timer: 0, duration, resolve, isWait: true }));
    }

    add(...objs) {
        let needsBake = false;
        const addRecursive = (o) => {
            if (!this.mobjects.includes(o)) {
                this.mobjects.push(o);
                if (o.triangles) needsBake = true;
            }
            if (o.children) o.children.forEach(addRecursive);
        };
        objs.forEach(addRecursive);

        if (this.engine && needsBake) {
            // FIX: Automatically load textures for objects added mid-animation
            this.engine.loadMeshesTextures(this.mobjects).then(() => {
                this.engine.bakeMeshes(this.mobjects);
                this.frameCount = 0;
            });
        } else {
            this.frameCount = 0;
        }

        populateSceneGraph(this.mobjects);
    }

    remove(...objs) {
        let needsBake = false;
        let didRemove = false;
        objs.forEach(o => {
            const index = this.mobjects.indexOf(o);
            if (index !== -1) { this.mobjects.splice(index, 1); didRemove = true; if (o.triangles) needsBake = true; }
        });
        if (this.engine && needsBake) this.engine.bakeMeshes(this.mobjects);
        this.frameCount = 0;

        if (didRemove) populateSceneGraph(this.mobjects);
    }

    _stepTimeline(dt) {
        let isAnimating = false;
        if (this.activeAnimations.length > 0) {
            isAnimating = true;
            for (let i = this.activeAnimations.length - 1; i >= 0; i--) {
                let group = this.activeAnimations[i];
                if (group.isWait) {
                    group.timer += dt;
                    if (group.timer >= group.duration) { group.resolve(); this.activeAnimations.splice(i, 1); }
                } else {
                    let allFinished = true;
                    group.animations.forEach(anim => {
                        if (anim.finished) return;
                        anim.t += dt; let rawAlpha = Math.min(anim.t / anim.run_time, 1.0);
                        if (rawAlpha >= 1.0) { anim.finish(); anim.finished = true; }
                        else { anim.update(anim.rate_func(rawAlpha)); allFinished = false; }
                    });
                    if (allFinished) { group.resolve(); this.activeAnimations.splice(i, 1); }
                }
            }
        }
        return isAnimating;
    }

    async rebuildScene(targetTime = 0) {
        if (this._isRebuilding) {
            this._pendingRebuildTime = targetTime;
            return;
        }
        this._isRebuilding = true;

        const curCam = this.camera;
        this.mobjects = [];
        this.activeAnimations = [];
        this.clock = 0;

        this.camera = { ...curCam };
        if (this.cameraController) this.cameraController.camera = this.camera;

        await this.setup();
        this.construct();

        if (targetTime > 0) {
            // Because construct() is async and uses 'await this.play()', javascript's microtask queue
            // must be allowed to process so construct() can resume and queue up subsequent animations.
            // By yielding with 'await Promise.resolve()' at each simulation tick, we flush the microtasks
            // instantly without yielding to the browser's Macrotask paint queue, keeping it incredibly fast.
            const simDt = 1.0 / 60.0;
            if (this.interactionManager) this.interactionManager.play();
            while (this.clock < targetTime) {
                let step = Math.min(simDt, targetTime - this.clock);
                this.clock += step;
                this._stepTimeline(step);
                const runUpdaters = (m, dt) => { m.updaters.forEach(fn => fn(m, dt)); if (m.children) m.children.forEach(c => runUpdaters(c, dt)); };
                this.mobjects.forEach(m => runUpdaters(m, step));
                if (this.alwaysUpdate) this.alwaysUpdate(step, this.clock);
                if (this.interactionManager && this.interactionManager.isPlaying) {
                    this.interactionManager.applyEventsForTime(this.clock, this.mobjects);
                }

                // CRITICAL: Yield to JS Microtask Queue so async construct() can advance!
                await Promise.resolve();
            }
        } else {
            if (this.interactionManager) this.interactionManager.stop();
        }

        if (this.engine) this.engine.bakeMeshes(this.mobjects);
        populateSceneGraph(this.mobjects);
        this.frameCount = 0;
        document.getElementById('scrubber').value = this.clock;
        document.getElementById('timeDisplay').innerText = this.clock.toFixed(2) + "s";

        this._isRebuilding = false;
        if (this._pendingRebuildTime !== undefined) {
            const nextTime = this._pendingRebuildTime;
            this._pendingRebuildTime = undefined;
            // Fire the next rebuild continuously matching the very latest scrub target
            this.rebuildScene(nextTime);
        }
    }

    async setup() { }
    async construct() { }

    async run() {
        this.engine = new RenderEngine(document.getElementById('canvas'));
        this.cameraController = new CameraController(this.camera, document.getElementById('canvas'));
        this.oidnManager = new OIDNManager(this.engine);
        this.oidnReady = false; this.isProcessingOIDN = false;

        // --- Interaction Recording/Playback ---
        this.interactionManager = new InteractionManager();
        this.cameraController.recorder = this.interactionManager.recorder;
        this.cameraController.sceneClock = () => this.clock;

        // --- NEW: Debounce Window Resizing ---
        let resizeTimeout = null;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                const vpNode = document.getElementById('viewport-container');
                this.engine.resize(vpNode.clientWidth, vpNode.clientHeight);
                this.frameCount = 0; // Reset accumulation after resize
            }, 150); // Waits 150ms after dragging stops to avoid GPU context crashes
        });

        const btnRT = document.getElementById('btnToggleRT');
        btnRT.addEventListener('click', () => {
            this.cameraController.rtEnabled = !this.cameraController.rtEnabled; this.frameCount = 0;
            if (this.cameraController.rtEnabled) {
                btnRT.innerText = "Disable Ray Tracing (T)"; btnRT.style.background = "#d32f2f";
                document.getElementById('status').innerText = "Status: Accumulating... (Clear)"; document.getElementById('status').style.color = "#4CAF50";
            } else {
                btnRT.innerText = "Enable Ray Tracing (T)"; btnRT.style.background = "var(--accent)";
                document.getElementById('status').innerText = "Status: RT OFF (Preview)"; document.getElementById('status').style.color = "#9e9e9e";
            }
        });

        const btnDoF = document.getElementById('btnToggleDoF');
        btnDoF.addEventListener('click', () => {
            this.cameraController.useDoF = !this.cameraController.useDoF; this.frameCount = 0;
            if (this.cameraController.useDoF) { btnDoF.innerText = "Disable Focus Blur (B)"; btnDoF.style.background = "#7b1fa2"; }
            else { btnDoF.innerText = "Enable Focus Blur (B)"; btnDoF.style.background = "#5e35b1"; }
        });


        document.getElementById('selBVHMethod').addEventListener('change', async (e) => {
            const method = e.target.value;
            this.engine.bvhMethod = method;

            // 1. PAUSE THE ENGINE (Fixes the race condition)
            this.isBaking = true;

            this.mobjects.forEach(m => {
                if (m.triangles) m.bvhDirty = true;
            });

            document.getElementById('status').innerText = `Status: Rebuilding BVH (${method.toUpperCase()})...`;
            document.getElementById('status').style.color = "#FFC107";

            // 2. Yield to the browser so the UI text actually updates
            await new Promise(resolve => setTimeout(resolve, 20));

            // 3. Bake the new BVH
            this.engine.bakeMeshes(this.mobjects, method);

            // 4. NOW that the new BVH is ready, reset the dynamic GPU buffers
            this.mobjects.forEach(m => {
                // If it's a dynamic mesh (like Water) that uses GPU setup
                if (m.triangles && m.gpuSetupDone !== undefined) {
                    m.gpuSetupDone = false;
                    if (m.bufFlags) { m.bufFlags.destroy(); m.bufFlags = null; }
                    if (m.bufLeafIndices) { m.bufLeafIndices.destroy(); m.bufLeafIndices = null; }
                }
            });

            this.frameCount = 0;

            // 5. RESUME THE ENGINE
            this.isBaking = false;
        });


        // --- NEW RT TECHNIQUE DROPDOWN LISTENER ---
        document.getElementById('selRTTechnique').addEventListener('change', (e) => {
            this.engine.rtTechnique = parseInt(e.target.value);
            this.frameCount = 0;
        });
        document.getElementById('selCamModel').addEventListener('change', (e) => {
            this.camera.model = parseInt(e.target.value);
            this.frameCount = 0;
        });

        document.getElementById('uiFov').addEventListener('input', (e) => { this.camera.fov = parseFloat(e.target.value) * Math.PI / 180; this.frameCount = 0; });
        document.getElementById('uiAperture').addEventListener('input', (e) => { this.camera.aperture = parseFloat(e.target.value); this.frameCount = 0; });
        document.getElementById('uiFocus').addEventListener('input', (e) => {
            this.camera.focusDist = parseFloat(e.target.value);
            this.cameraController.autoFocus = false;
            this.frameCount = 0;
        });
        document.getElementById('btnAutoFocus').addEventListener('click', () => { this.cameraController.autoFocus = !this.cameraController.autoFocus; this.cameraController.fPressed = true; });

        document.getElementById('uiSkyIntensity').addEventListener('input', (e) => {
            this.camera.skyIntensity = parseFloat(e.target.value);
            document.getElementById('skyIntensityVal').innerText = this.camera.skyIntensity.toFixed(1);
            this.frameCount = 0;
        });
        document.getElementById('uiGIMultiplier').addEventListener('input', (e) => {
            this.camera.giMultiplier = parseFloat(e.target.value);
            document.getElementById('giMultiplierVal').innerText = this.camera.giMultiplier.toFixed(1);
            this.frameCount = 0;
        });


        // Dynamic UI logic for Camera Models
        document.getElementById('selCamModel').addEventListener('change', (e) => {
            this.camera.model = parseInt(e.target.value);
            this.frameCount = 0;

            // Show/Hide sliders based on the active camera type
            document.getElementById('rowOrthoScale').style.display = this.camera.model === 1 ? 'flex' : 'none';
            document.getElementById('rowFov').style.display = (this.camera.model === 1 || this.camera.model === 3) ? 'none' : 'flex';
        });

        // Lens Parameter Sliders
        document.getElementById('uiOrthoScale').addEventListener('input', (e) => {
            this.camera.orthoScale = parseFloat(e.target.value);
            document.getElementById('orthoScaleVal').innerText = this.camera.orthoScale.toFixed(1);
            this.frameCount = 0;
        });
        document.getElementById('uiLensShiftX').addEventListener('input', (e) => {
            this.camera.lensShiftX = parseFloat(e.target.value);
            document.getElementById('lensShiftXVal').innerText = this.camera.lensShiftX.toFixed(2);
            this.frameCount = 0;
        });
        document.getElementById('uiLensShiftY').addEventListener('input', (e) => {
            this.camera.lensShiftY = parseFloat(e.target.value);
            document.getElementById('lensShiftYVal').innerText = this.camera.lensShiftY.toFixed(2);
            this.frameCount = 0;
        });

        document.getElementById('selPreviewDenoiser').addEventListener('change', () => { this.frameCount = 0; this.oidnReady = false; });
        document.getElementById('selOfflineDenoiser').addEventListener('change', () => { });
        document.getElementById('inpPreviewSpp').addEventListener('change', () => { this.frameCount = 0; });
        document.getElementById('inpBounces').addEventListener('input', (e) => { this.camera.bounces = parseInt(e.target.value); this.frameCount = 0; });

        document.getElementById('btnRender').addEventListener('click', () => {
            const fps = parseInt(document.getElementById('inpFps').value), dur = parseFloat(document.getElementById('inpDur').value), spp = parseInt(document.getElementById('inpSpp').value);
            const useInteraction = document.getElementById('chkUseInteraction').checked;

            let exportData = null;
            if (useInteraction && this.interactionManager.tracks.length > 0) {
                // We bundle the currently active tracks
                exportData = {
                    version: 2,
                    tracks: this.interactionManager.tracks.map(t => ({
                        name: t.name,
                        isEnabled: t.isEnabled,
                        recording: t.recording
                    }))
                };
            }
            this.startOfflineRender(fps, dur, spp, exportData);
        });

        // --- Interaction Recording UI ---
        const updateInteractionUI = () => {
            const hasTracks = this.interactionManager.tracks.length > 0;
            document.getElementById('btnExportInteraction').disabled = !hasTracks;
            document.getElementById('btnClearInteraction').disabled = !hasTracks;
            document.getElementById('btnPlayInteraction').disabled = !hasTracks;
            document.getElementById('chkUseInteraction').checked = hasTracks;

            // Render Track List
            const trackListEl = document.getElementById('interactionTrackList');
            trackListEl.innerHTML = '';

            if (!hasTracks) {
                trackListEl.innerHTML = '<div style="font-size: 10px; color: #777; text-align: center;">No tracks recorded.</div>';
                return;
            }

            this.interactionManager.tracks.forEach((track, index) => {
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.justifyContent = 'space-between';
                row.style.background = 'rgba(255,255,255,0.05)';
                row.style.padding = '2px 6px';
                row.style.borderRadius = '3px';

                const leftDiv = document.createElement('div');
                leftDiv.style.display = 'flex';
                leftDiv.style.alignItems = 'center';
                leftDiv.style.gap = '6px';

                const chk = document.createElement('input');
                chk.type = 'checkbox';
                chk.checked = track.isEnabled;
                chk.style.margin = '0';
                chk.addEventListener('change', (e) => {
                    track.isEnabled = e.target.checked;
                });

                const nameLabel = document.createElement('span');
                nameLabel.style.fontSize = '11px';
                nameLabel.style.color = '#ddd';
                nameLabel.innerText = `${track.name} (${track.recording.eventCount} evts)`;

                leftDiv.appendChild(chk);
                leftDiv.appendChild(nameLabel);

                const delBtn = document.createElement('button');
                delBtn.innerText = '✖';
                delBtn.style.background = 'transparent';
                delBtn.style.border = 'none';
                delBtn.style.color = '#f44336';
                delBtn.style.cursor = 'pointer';
                delBtn.style.fontSize = '10px';
                delBtn.style.padding = '0 4px';
                delBtn.title = `Delete ${track.name}`;
                delBtn.addEventListener('click', () => {
                    this.interactionManager.tracks.splice(index, 1);
                    updateInteractionUI();
                });

                row.appendChild(leftDiv);
                row.appendChild(delBtn);
                trackListEl.appendChild(row);
            });
        };

        document.getElementById('btnRecordInteraction').addEventListener('click', () => {
            this.interactionManager.startRecording(this.clock);
            document.getElementById('btnRecordInteraction').disabled = true;
            document.getElementById('btnStopRecord').disabled = false;

            // Sync with presentation buttons
            const btnPres = document.getElementById('btnPresentation');
            const btnStopPres = document.getElementById('btnStopPresentation');
            if (btnPres) btnPres.disabled = true;
            if (btnStopPres) btnStopPres.disabled = false;
        });

        document.getElementById('btnStopRecord').addEventListener('click', () => {
            this.interactionManager.stopRecording();
            document.getElementById('btnRecordInteraction').disabled = false;
            document.getElementById('btnStopRecord').disabled = true;

            // Sync with presentation buttons
            const btnPres = document.getElementById('btnPresentation');
            const btnStopPres = document.getElementById('btnStopPresentation');
            if (btnPres) btnPres.disabled = false;
            if (btnStopPres) btnStopPres.disabled = true;

            updateInteractionUI();
        });

        // Dedicated Replay Button: Rewinds the main timeline and hits play
        document.getElementById('btnPlayInteraction').addEventListener('click', async () => {
            // Find earliest event in active tracks
            let minStart = 0;
            this.interactionManager.tracks.forEach(t => {
                if (t.isEnabled && t.recording && t.recording.events.length > 0) {
                    const firstEvt = t.recording.events[0].t;
                    if (minStart === 0 || firstEvt < minStart) minStart = firstEvt;
                }
            });
            // Rewind slightly before the first action, or to 0
            const rewindTime = Math.max(0, minStart - 0.5);

            await this.rebuildScene(rewindTime);
            document.getElementById('scrubber').value = rewindTime;

            const btnPlay = document.getElementById('btnPlay');
            if (!this.isPlaying) {
                btnPlay.click(); // Trigger main timeline play
            } else {
                this.interactionManager.play(); // Already playing, just ensure interaction manager is active
            }
        });

        document.getElementById('btnExportInteraction').addEventListener('click', () => {
            this.interactionManager.exportAll();
        });

        document.getElementById('btnLoadInteraction').addEventListener('click', () => {
            document.getElementById('fileInteraction').click();
        });

        document.getElementById('fileInteraction').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    this.interactionManager.loadAll(ev.target.result);
                    updateInteractionUI();
                } catch (err) {
                    console.error("Failed to load tracks", err);
                }
            };
            reader.readAsText(file);
            e.target.value = ''; // Reset so same file can be re-loaded
        });

        document.getElementById('btnClearInteraction').addEventListener('click', () => {
            this.interactionManager.clear();
            updateInteractionUI();
        });

        // Initialize empty UI
        updateInteractionUI();

        const btnPlay = document.getElementById('btnPlay');
        const btnStop = document.getElementById('btnStop');
        const btnLoop = document.getElementById('btnLoop');
        const inpLoopStart = document.getElementById('inpLoopStart');
        const inpLoopEnd = document.getElementById('inpLoopEnd');
        const selSpeed = document.getElementById('selSpeed');
        const scrubber = document.getElementById('scrubber');

        btnPlay.addEventListener('click', () => {
            this.isPlaying = !this.isPlaying;
            btnPlay.innerText = this.isPlaying ? "⏸" : "▶";
            btnPlay.classList.toggle('active', this.isPlaying);
            if (this.isPlaying) this.interactionManager.play();
            else this.interactionManager.stop();
        });
        btnPlay.classList.toggle('active', this.isPlaying);

        btnStop.addEventListener('click', () => {
            this.isPlaying = false; btnPlay.innerText = "▶"; btnPlay.classList.remove('active');
            this.interactionManager.stop();
            this.rebuildScene(0);
        });

        const btnPresentation = document.getElementById('btnPresentation');
        const btnStopPresentation = document.getElementById('btnStopPresentation');

        btnPresentation.addEventListener('click', async () => {
            this.isPlaying = true;
            btnPlay.innerText = "⏸";
            btnPlay.classList.add('active');

            await this.rebuildScene(0);
            this.interactionManager.startRecording(0);

            btnPresentation.disabled = true;
            btnStopPresentation.disabled = false;

            // Sync with other record buttons if they exist
            document.getElementById('btnRecordInteraction').disabled = true;
            document.getElementById('btnStopRecord').disabled = false;
        });

        btnStopPresentation.addEventListener('click', () => {
            this.interactionManager.stopRecording();
            this.isPlaying = false;
            btnPlay.innerText = "▶"; btnPlay.classList.remove('active');

            btnPresentation.disabled = false;
            btnStopPresentation.disabled = true;

            // Sync with other record buttons
            document.getElementById('btnRecordInteraction').disabled = false;
            document.getElementById('btnStopRecord').disabled = true;

            updateInteractionUI();
        });

        btnLoop.addEventListener('click', () => {
            this.isLooping = !this.isLooping;
            btnLoop.classList.toggle('active', this.isLooping);
        });

        inpLoopStart.addEventListener('change', (e) => { this.loopStart = Math.max(0, parseFloat(e.target.value)); });
        inpLoopEnd.addEventListener('change', (e) => {
            this.loopEnd = Math.max(this.loopStart + 0.5, parseFloat(e.target.value));
            scrubber.max = this.loopEnd;
        });
        selSpeed.addEventListener('change', (e) => { this.playbackSpeed = parseFloat(e.target.value); });

        let isScrubbing = false;
        let lastScrubTime = 0;
        scrubber.addEventListener('mousedown', () => { isScrubbing = true; });
        scrubber.addEventListener('input', async (e) => {
            const val = parseFloat(e.target.value);
            document.getElementById('timeDisplay').innerText = val.toFixed(2) + "s";

            const now = Date.now();
            if (now - lastScrubTime > 100) { // Max 10fps rebuild while dragging to prevent lockups
                lastScrubTime = now;
                await this.rebuildScene(val);
            }
        });
        scrubber.addEventListener('change', async (e) => {
            isScrubbing = false;
            await this.rebuildScene(parseFloat(e.target.value));
        });
        this.isScrubbing = () => isScrubbing;

        document.querySelectorAll('button, select, input').forEach(elem => {
            // Always blur after a value is actually changed so hotkeys work again
            elem.addEventListener('change', function () { this.blur(); });

            // ONLY blur buttons on click. If you blur a select/input on click, it instantly closes/unfocuses!
            if (elem.tagName.toLowerCase() === 'button') {
                elem.addEventListener('click', function () { this.blur(); });
            }
        });
        await this.engine.init();
        await this.setup();
        this.construct();

        document.getElementById('status').innerText = "Status: Loading Textures & Baking BVH...";
        document.getElementById('status').style.color = "#FFC107";

        await this.engine.loadMeshesTextures(this.mobjects);
        this.engine.bakeMeshes(this.mobjects);
        populateSceneGraph(this.mobjects);

        document.getElementById('status').innerText = "Status: Ready";
        document.getElementById('status').style.color = "#9e9e9e";

        requestAnimationFrame(async t => { this.lastTime = t; await this._loop(t); });
    }
    async _loop(time) {
        if (window.isRenderingVideo || this.isBaking) {
            this.lastTime = time;
            requestAnimationFrame(async t => await this._loop(t));
            return;
        }

        const rawDt = (time - this.lastTime) / 1000.0;
        this.lastTime = time;

        const dt = Math.min(rawDt, 0.1) * this.playbackSpeed;

        let isAnimating = false;
        let updaterRan = false;

        if (this.isPlaying && !this.isScrubbing()) {
            this.clock += dt;

            if (this.isLooping && this.clock >= this.loopEnd) {
                this.rebuildScene(this.loopStart);
                return;
            }

            isAnimating = this._stepTimeline(dt);

            const runUpdaters = (m, dt) => { m.updaters.forEach(fn => { fn(m, dt); updaterRan = true; }); if (m.children) m.children.forEach(c => runUpdaters(c, dt)); };
            this.mobjects.forEach(m => runUpdaters(m, dt));

            if (this.alwaysUpdate) { this.alwaysUpdate(dt, this.clock); isAnimating = true; }

            document.getElementById('scrubber').value = this.clock;
            document.getElementById('timeDisplay').innerText = this.clock.toFixed(2) + "s";
        }

        if (updaterRan) isAnimating = true;

        drawGimbal(this.camera);

        if (globalVectorAtlas.textureReady && this.engine && this.engine.vectorTexture) {
            this.engine.device.queue.copyExternalImageToTexture({ source: globalVectorAtlas.canvas }, { texture: this.engine.vectorTexture }, [globalVectorAtlas.canvas.width, globalVectorAtlas.canvas.height]);
            globalVectorAtlas.textureReady = false; this.frameCount = 0;
        }

        if (this.cameraController) {
            let safeDt = Math.min(rawDt, 0.1);
            if (this.cameraController.update(safeDt, this.mobjects)) isAnimating = true;
        }

        // --- Interaction Playback ---
        if (this.interactionManager && this.interactionManager.isPlaying && !this.interactionManager.isRecording) {
            // We only apply events here if NOT recording, because if we ARE recording,
            // the startRecording() has already played everything, but we don't want the 
            // the live playing tracks to interfere with the live raycast mouse dragging, 
            // although they don't natively interfere since active mobjects are cleanly separated.
            // Wait, actually we DO want to apply events during recording so we see other objects move!
        }

        if (this.interactionManager && (this.interactionManager.isPlaying || this.interactionManager.isRecording)) {
            if (this.interactionManager.applyEventsForTime(this.clock, this.mobjects)) {
                isAnimating = true;
            }
        }

        if (isAnimating) {
            window.dispatchEvent(new CustomEvent('playback-tick'));
        }

        if (isAnimating || this.isScrubbing()) {
            this.frameCount = 0;
            this.oidnReady = false;
        }
        if (!isAnimating && !this.isScrubbing() && this.frameCount > 8000 && this.cameraController.rtEnabled) {
            requestAnimationFrame(async t => await this._loop(t));
            return;
        }

        const previewSpp = parseInt(document.getElementById('inpPreviewSpp').value) || 1;
        const activeSpp = previewSpp;

        const originalBounces = this.camera.bounces;
        if ((isAnimating || this.isScrubbing()) && this.cameraController.rtEnabled) {
            this.camera.bounces = Math.min(originalBounces, 5);
        }

        // --- DYNAMIC OIDN DROPDOWN PARSER ---
        const previewVal = document.getElementById('selPreviewDenoiser').value;
        let previewDenoiserMode = 0;
        if (previewVal === 'spatial') previewDenoiserMode = 1;
        else if (previewVal !== 'none' && previewVal !== '0') previewDenoiserMode = 2; // OIDN Active

        const isOidn = previewDenoiserMode === 2;
        const oidnModel = isOidn ? previewVal : null; // Extracts the exact .tza filename

        let denoiseStr = 'OFF';
        if (previewDenoiserMode === 1) denoiseStr = 'FAST';
        else if (isOidn) denoiseStr = oidnModel.toUpperCase();

        document.getElementById('denoiseUI').innerText = `Denoiser: ${denoiseStr}`;
        document.getElementById('denoiseUI').style.color = previewDenoiserMode === 0 ? '#777' : (previewDenoiserMode === 1 ? '#FFC107' : '#00bcd4');

        if (isOidn && (!this.oidnManager.isInitialized || this.oidnManager.currentModel !== oidnModel)) {
            this.oidnManager.init(oidnModel);
        }

        if (this.engine) {
            // Pass the numeric mode to the shader
            this.engine.device.queue.writeBuffer(this.engine.postProcBuffer, 0, new Float32Array([previewDenoiserMode, this.frameCount, this.oidnReady ? 1.0 : 0.0, 0]));

            // Force the fast spatial denoise on while the timeline plays if an AI denoiser is selected to eliminate grain
            const activeDenoiser = (previewDenoiserMode === 1 || (isOidn && (isAnimating || this.isScrubbing()))) && this.cameraController.rtEnabled;
            this.engine.update(this.mobjects, this.camera, this.frameCount, activeDenoiser, this.cameraController.rtEnabled, this.cameraController.useDoF, activeSpp);
            this.engine.render(this.frameCount, false, this.mobjects);
        }

        this.camera.bounces = originalBounces;

        if (!isAnimating && !this.isScrubbing() && isOidn && this.cameraController.rtEnabled && !this.isProcessingOIDN && this.frameCount >= 4) {
            this.isProcessingOIDN = true;
            const startFrame = this.frameCount;

            let f = async () => {
                try {
                    await this.oidnManager.init(oidnModel);
                    await this.oidnManager.denoise(startFrame);
                    if (this.frameCount >= startFrame) { this.oidnReady = true; }
                } catch (err) {
                    console.error("OIDN Async Error:", err);
                } finally {
                    this.isProcessingOIDN = false;
                }
            };

            // --- SMOOTH VIEWPORT STROBE FIX ---
            if (this.frameCount < 60) {
                if (this.frameCount % 5 === 0) f();
                else this.isProcessingOIDN = false;
            } else {
                if (this.frameCount % 30 === 0) f();
                else this.isProcessingOIDN = false;
            }
        }

        document.getElementById('uiFov').value = (this.camera.fov * 180 / Math.PI);
        document.getElementById('fovVal').innerText = `${(this.camera.fov * 180 / Math.PI).toFixed(0)}°`;
        document.getElementById('uiAperture').value = this.camera.aperture;
        document.getElementById('apertureVal').innerText = this.camera.aperture.toFixed(2) + (this.cameraController.useDoF ? '' : ' (X)');
        document.getElementById('uiFocus').value = this.camera.focusDist;
        document.getElementById('focusVal').innerText = this.camera.focusDist.toFixed(2) + (this.cameraController.autoFocus ? ' (A)' : '');

        if (!this.cameraController.rtEnabled) {
            document.getElementById('status').innerText = "Status: RT OFF (Fast Preview)"; document.getElementById('status').style.color = "#9e9e9e";
            document.getElementById('frames').innerText = `Realtime Samples: 1 (RT OFF)`;
        } else {
            document.getElementById('frames').innerText = `Realtime Samples: ${(this.frameCount + 1) * activeSpp}`;

            if (!this.isProcessingOIDN && !isOidn) {
                if (isAnimating || this.isScrubbing()) { document.getElementById('status').innerText = "Status: Realtime Animated (Fast Mode)"; document.getElementById('status').style.color = "#ff9800"; }
                else if (this.frameCount >= 8000) { document.getElementById('status').innerText = "Status: Converged (Paused)"; document.getElementById('status').style.color = "#9c27b0"; }
                else { document.getElementById('status').innerText = "Status: Accumulating... (Clear)"; document.getElementById('status').style.color = "#4CAF50"; }
            } else if (isOidn) {
                if (isAnimating || this.isScrubbing()) { document.getElementById('status').innerText = "Status: Realtime Animated (Fast Mode)"; document.getElementById('status').style.color = "#ff9800"; }
                else { document.getElementById('status').innerText = `Status: AI Denoising Asynchronously (${oidnModel})...`; document.getElementById('status').style.color = "#00bcd4"; }
            }
        }

        this.frameCount++; requestAnimationFrame(async t => await this._loop(t));
    }

    async startOfflineRender(fps, duration, targetSpp, interactionData = null) {
        window.isRenderingVideo = true;

        // Set up InteractionManager for offline render if provided
        let offlineManager = null;
        if (interactionData) {
            offlineManager = new InteractionManager();
            offlineManager.loadAll(interactionData);
            offlineManager.play();
        }

        // --- FORCE CLASSIC PATH TRACING FOR OFFLINE CLARITY ---
        const originalTechnique = this.engine.rtTechnique;
        this.engine.rtTechnique = 0;

        document.getElementById('status').innerText = "Status: OFFLINE RENDERING...";
        document.getElementById('status').style.color = "#e91e63";
        document.getElementById('progressContainer').style.display = "block";

        const totalFrames = fps * duration;
        const dt = 1.0 / fps;

        const resString = document.getElementById('selResolution').value;
        const [targetW, targetH] = resString.split('x').map(Number);
        this.engine.resize(targetW, targetH);

        const tempCanvas = new OffscreenCanvas(this.engine.width, this.engine.height);
        const tempCtx = tempCanvas.getContext('webgpu');
        tempCtx.configure({
            device: this.engine.device,
            format: this.engine.presentationFormat,
            alphaMode: 'opaque'
        });

        const { Muxer, ArrayBufferTarget } = await import('webm-muxer');
        const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'V_VP9', width: this.engine.width, height: this.engine.height } });

        const videoEncoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => console.error("VideoEncoder error:", e) });
        videoEncoder.configure({ codec: 'vp09.00.10.08', width: this.engine.width, height: this.engine.height, bitrate: 15_000_000, framerate: fps });

        const cleanupObject = (m) => { if (m instanceof VideoObject) { m.video.pause(); m.video.removeAttribute('src'); m.video.load(); } if (m.children) m.children.forEach(cleanupObject); };
        this.mobjects.forEach(cleanupObject);
        globalVectorAtlas.clear();

        this.mobjects = []; this.activeAnimations = []; this.clock = 0;

        const curCam = this.camera;
        const offlineBounces = parseInt(document.getElementById('inpOfflineBounces').value) || 5;

        this.camera = {
            ...curCam,
            pos: [...curCam.pos], dir: [...curCam.dir], right: [...curCam.right], up: [...curCam.up], skyColor: [...curCam.skyColor],
            bounces: offlineBounces
        };

        if (this.cameraController) {
            this.cameraController.camera = this.camera;
            this.cameraController.keys = {};
        }

        await this.setup(); this.construct(); await Promise.resolve();

        await this.engine.loadMeshesTextures(this.mobjects);
        this.engine.bakeMeshes(this.mobjects);
        populateSceneGraph(this.mobjects);

        // --- DYNAMIC OFFLINE OIDN PARSER ---
        const offlineVal = document.getElementById('selOfflineDenoiser').value;
        let offlineDenoiserMode = 0;
        if (offlineVal === 'spatial') offlineDenoiserMode = 1;
        else if (offlineVal !== 'none' && offlineVal !== '0') offlineDenoiserMode = 2;

        const isOfflineOidn = offlineDenoiserMode === 2;
        const offlineOidnModel = isOfflineOidn ? offlineVal : null;
        const tileSizeSelect = parseInt(document.getElementById('selTileSize').value);

        const tiles = [];
        if (tileSizeSelect > 0) {
            for (let y = 0; y < this.engine.height; y += tileSizeSelect) {
                for (let x = 0; x < this.engine.width; x += tileSizeSelect) {
                    tiles.push({ x, y, width: Math.min(tileSizeSelect, this.engine.width - x), height: Math.min(tileSizeSelect, this.engine.height - y) });
                }
            }
        } else {
            tiles.push({ x: 0, y: 0, width: this.engine.width, height: this.engine.height });
        }

        for (let frame = 0; frame < totalFrames; frame++) {
            this.clock = frame * dt; this._stepTimeline(dt);

            const runUpdaters = (m, dt) => { m.updaters.forEach(fn => fn(m, dt)); if (m.children) m.children.forEach(c => runUpdaters(c, dt)); };
            this.mobjects.forEach(m => runUpdaters(m, dt));
            if (this.alwaysUpdate) this.alwaysUpdate(dt, this.clock);

            // Apply recorded interactions for this frame
            if (offlineManager && offlineManager.isPlaying) {
                offlineManager.applyEventsForTime(this.clock, this.mobjects);
            }

            let accFrame = 0;
            const passes = Math.ceil(targetSpp / 4);
            this.engine.useScissor = tileSizeSelect > 0;

            // LOCKED NOISE SEQUENCE: Resets to 0 every frame to prevent boiling video noise!
            let globalPassIndex = 0;

            for (let p = 0; p < passes; p++) {
                this.engine.device.queue.writeBuffer(this.engine.postProcBuffer, 0, new Float32Array([0, accFrame, 0, 0]));

                this.engine.update(this.mobjects, this.camera, accFrame, false, true, this.cameraController.useDoF, 4, globalPassIndex);

                for (let i = 0; i < tiles.length; i++) {
                    this.engine.tileRect = tiles[i];
                    const skipMorph = (i > 0); const skipScreen = true;
                    this.engine.render(accFrame, true, this.mobjects, skipMorph, skipScreen);
                }

                accFrame++;
                globalPassIndex++;
                document.getElementById('progressText').innerText = `Frame ${frame + 1} / ${totalFrames} (Pass ${p + 1}/${passes})`;
                await this.engine.device.queue.onSubmittedWorkDone();
                await new Promise(r => setTimeout(r, 15));
            }

            this.engine.useScissor = false;

            if (isOfflineOidn) {
                document.getElementById('progressText').innerText = `Frame ${frame + 1} / ${totalFrames} (AI Denoising [${offlineOidnModel}]...)`;

                await this.oidnManager.init(offlineOidnModel);
                await this.oidnManager.denoise(accFrame - 1);

                await this.engine.device.queue.onSubmittedWorkDone();
                this.engine.device.queue.writeBuffer(this.engine.postProcBuffer, 0, new Float32Array([offlineDenoiserMode, accFrame, 1.0, 0]));
            } else {
                this.engine.device.queue.writeBuffer(this.engine.postProcBuffer, 0, new Float32Array([offlineDenoiserMode, accFrame, 0.0, 0]));
            }

            const finalBg = (accFrame - 1) % 2 === 0 ? this.engine.screenBgA : this.engine.screenBgB;
            const enc = this.engine.device.createCommandEncoder();

            const targetTexture = tempCtx.getCurrentTexture();

            const screenPass = enc.beginRenderPass({
                colorAttachments: [{
                    view: targetTexture.createView(),
                    loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store'
                }]
            });
            screenPass.setPipeline(this.engine.screenPipeline);
            screenPass.setBindGroup(0, finalBg);
            screenPass.draw(3, 1, 0, 0);
            screenPass.end();

            this.engine.device.queue.submit([enc.finish()]);
            await this.engine.device.queue.onSubmittedWorkDone();

            const videoFrame = new VideoFrame(tempCanvas, { timestamp: Math.round((frame * 1_000_000) / fps) });

            videoEncoder.encode(videoFrame, { keyFrame: (frame % (fps * 2) === 0) });
            videoFrame.close();

            while (videoEncoder.encodeQueueSize > 5) { await new Promise(r => setTimeout(r, 10)); }
            document.getElementById('progressFill').style.width = `${((frame + 1) / totalFrames) * 100}%`;
        }

        document.getElementById('progressText').innerText = `Muxing video... Please wait.`;
        await videoEncoder.flush(); muxer.finalize();

        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([muxer.target.buffer], { type: 'video/webm' }));
        a.download = 'webgpu_cinematic_render.webm'; a.click();

        this.camera.bounces = parseInt(document.getElementById('inpBounces').value) || 5;

        const vpNode = document.getElementById('viewport-container');
        this.engine.resize(vpNode.clientWidth, vpNode.clientHeight);

        // --- RESTORE ORIGINAL RT TECHNIQUE ---
        this.engine.rtTechnique = originalTechnique;

        if (this.cameraController) this.cameraController.keys = {};

        window.isRenderingVideo = false; document.getElementById('progressContainer').style.display = "none";
        this.frameCount = 0; this.oidnReady = false; this.lastTime = performance.now();
        requestAnimationFrame(async t => await this._loop(t));
    }
}







function parseMTL(str) {
    const materials = {};
    let currentMat = null;
    str.split('\n').forEach(line => {
        line = line.split('#')[0].trim();
        if (!line) return;
        const p = line.split(/\s+/);

        if (line.startsWith('newmtl ')) {
            currentMat = line.substring(7).trim();
            materials[currentMat] = { color: [1, 1, 1], smoothness: 0.0, emColor: [0, 0, 0], emStrength: 0.0, trans: 0.0, ior: 1.5 };
        } else if (currentMat) {
            if (p[0] === 'Kd') materials[currentMat].color = [parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])];
            if (p[0] === 'Ke') {
                let r = parseFloat(p[1]), g = parseFloat(p[2]), b = parseFloat(p[3]);
                let maxVal = Math.max(r, g, b);
                if (maxVal > 0) { materials[currentMat].emColor = [r / maxVal, g / maxVal, b / maxVal]; materials[currentMat].emStrength = maxVal; }
                else { materials[currentMat].emColor = [0, 0, 0]; materials[currentMat].emStrength = 0.0; }
            }
            if (p[0] === 'Ns') { let ns = parseFloat(p[1]); if (ns > 0) materials[currentMat].smoothness = Math.min(1.0, Math.pow(ns / 1000.0, 0.33)); }
            if (p[0] === 'Pr') materials[currentMat].smoothness = 1.0 - parseFloat(p[1]);
            if (p[0] === 'd' || p[0] === 'Tr') materials[currentMat].trans = p[0] === 'd' ? 1.0 - parseFloat(p[1]) : parseFloat(p[1]);
            if (p[0] === 'Ni') materials[currentMat].ior = parseFloat(p[1]);

            if (p[0] === 'map_Kd') materials[currentMat].map_Kd = p[p.length - 1];
            if (p[0] === 'map_Bump' || p[0] === 'bump') materials[currentMat].map_Bump = p[p.length - 1];
        }
    });
    return materials;
}

async function loadOBJFromURL(url, isSmooth = true, mtl = true) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to load OBJ`);
        const objString = await response.text();
        const objData = parseOBJ(objString);

        let mtlUrl = null;
        if (typeof mtl === 'string') mtlUrl = new URL(mtl, url).href;
        else if (mtl === true) {
            if (objData.mtllib) mtlUrl = new URL(objData.mtllib, url).href;
            else mtlUrl = url.replace(/\.obj$/i, '.mtl');
        }

        if (mtlUrl) {
            try {
                const mtlResponse = await fetch(mtlUrl);
                if (mtlResponse.ok) {
                    const mtlString = await mtlResponse.text();
                    const materials = parseMTL(mtlString);

                    const group = new Group();
                    for (let matName in objData.groups) {
                        if (objData.groups[matName].length === 0) continue;
                        let mesh = new MeshObject(objData.groups[matName], isSmooth);
                        if (materials[matName]) {
                            let m = materials[matName];
                            mesh.set_material(m.color, m.smoothness, m.trans, m.ior, m.emColor, m.emStrength);
                            if (m.map_Kd) mesh.albedoUrl = new URL(m.map_Kd, mtlUrl).href;
                            if (m.map_Bump) mesh.normalUrl = new URL(m.map_Bump, mtlUrl).href;
                        }
                        group.add(mesh);
                    }
                    return group;
                }
            } catch (e) { console.warn("Failed to load MTL, falling back to default.", e); }
        }
        return new MeshObject(objData, isSmooth);
    } catch (error) { console.warn("Error fetching OBJ model.", error); return null; }
}

function parseOBJ(str) {
    const verts = [], normals = [], uvs = [];
    const faces = [];
    const faceMaterials = [];

    let hasNormals = false, hasUVs = false;
    let currentMaterial = 'default';
    let mtllib = null;

    str.split('\n').forEach(line => {
        line = line.split('#')[0].trim();
        if (!line) return;

        const p = line.split(/\s+/);
        if (line.startsWith('mtllib ')) mtllib = line.substring(7).trim();
        else if (line.startsWith('usemtl ')) currentMaterial = line.substring(7).trim();
        else if (p[0] === 'v') verts.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]);
        else if (p[0] === 'vn') { normals.push([parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])]); hasNormals = true; }
        else if (p[0] === 'vt') { uvs.push([parseFloat(p[1]), parseFloat(p[2])]); hasUVs = true; }
        else if (p[0] === 'f') {
            for (let i = 2; i < p.length - 1; i++) {
                faces.push([p[1], p[i], p[i + 1]]);
                faceMaterials.push(currentMaterial);
            }
        }
    });

    let vertexNormals = [];
    if (!hasNormals) vertexNormals = Array(verts.length).fill(0).map(() => [0, 0, 0]);

    const parsedTris = [];
    faces.forEach((f, idx) => {
        let v_idx = [], n_idx = [], t_idx = [];
        for (let i = 0; i < 3; i++) {
            let parts = f[i].split('/');
            let vi = parseInt(parts[0]); vi = (vi < 0) ? (verts.length + vi) : (vi - 1); v_idx.push(vi);

            if (hasUVs && parts[1]) { let ti = parseInt(parts[1]); ti = (ti < 0) ? (uvs.length + ti) : (ti - 1); t_idx.push(ti); }
            else { t_idx.push(-1); }

            if (hasNormals && parts[2]) { let ni = parseInt(parts[2]); ni = (ni < 0) ? (normals.length + ni) : (ni - 1); n_idx.push(ni); }
            else { n_idx.push(vi); }
        }

        if (!hasNormals) {
            let v0 = verts[v_idx[0]], v1 = verts[v_idx[1]], v2 = verts[v_idx[2]];
            if (v0 && v1 && v2) {
                let dx1 = v1[0] - v0[0], dy1 = v1[1] - v0[1], dz1 = v1[2] - v0[2]; let dx2 = v2[0] - v0[0], dy2 = v2[1] - v0[1], dz2 = v2[2] - v0[2];
                let nx = dy1 * dz2 - dz1 * dy2, ny = dz1 * dx2 - dx1 * dz2, nz = dx1 * dy2 - dy1 * dx2;
                for (let i = 0; i < 3; i++) { if (vertexNormals[v_idx[i]]) { vertexNormals[v_idx[i]][0] += nx; vertexNormals[v_idx[i]][1] += ny; vertexNormals[v_idx[i]][2] += nz; } }
            }
        }
        parsedTris.push({ v: v_idx, n: n_idx, t: t_idx, mat: faceMaterials[idx] });
    });

    if (!hasNormals) {
        for (let i = 0; i < vertexNormals.length; i++) {
            let len = Math.hypot(vertexNormals[i][0], vertexNormals[i][1], vertexNormals[i][2]);
            if (len > 0) { vertexNormals[i][0] /= len; vertexNormals[i][1] /= len; vertexNormals[i][2] /= len; } else { vertexNormals[i] = [0, 1, 0]; }
        }
    }

    const finalTriangles = [];
    finalTriangles.groups = {};
    finalTriangles.mtllib = mtllib;

    parsedTris.forEach(t => {
        let v0 = verts[t.v[0]], v1 = verts[t.v[1]], v2 = verts[t.v[2]];
        if (!v0 || !v1 || !v2) return;
        let n0, n1, n2;
        if (hasNormals) { n0 = normals[t.n[0]] || [0, 1, 0]; n1 = normals[t.n[1]] || [0, 1, 0]; n2 = normals[t.n[2]] || [0, 1, 0]; }
        else { n0 = vertexNormals[t.n[0]] || [0, 1, 0]; n1 = vertexNormals[t.n[1]] || [0, 1, 0]; n2 = vertexNormals[t.n[2]] || [0, 1, 0]; }

        let uv0 = (t.t[0] !== -1) ? uvs[t.t[0]] : [0, 0];
        let uv1 = (t.t[1] !== -1) ? uvs[t.t[1]] : [0, 0];
        let uv2 = (t.t[2] !== -1) ? uvs[t.t[2]] : [0, 0];

        let tri = [v0, v1, v2, n0, n1, n2, uv0, uv1, uv2];
        finalTriangles.push(tri);

        let m = t.mat || 'default';
        if (!finalTriangles.groups[m]) finalTriangles.groups[m] = [];
        finalTriangles.groups[m].push(tri);
    });

    return finalTriangles;
}




// ==========================================
// Classic Cornell Box Demo Scene
// ==========================================
export class CornellBoxScene extends Scene {
    async setup() {
        // To fetch the scene, replace with your actual file URL or local server string
        this.scene = await loadOBJFromURL(window.location.origin + "/res/model/model.obj", true);
    }

    async construct() {
        this.camera.pos = [-0.1, 0.5, 5.4];
        this.camera.dir = Math3D.normalize(Math3D.sub([-0.1, 0.5, 0], this.camera.pos));

        if (this.scene) {
            this.scene.position = [0, 0, 0];
            this.add(this.scene);
        }
    }
}


export class NativeWaterScene extends Scene {
    async setup() {
        // 1. Initialize the Native WebGPU Water
        this.water = new NativeGPUWater(500, 15.0);
        this.water.scene = this;

        // DELETE the old initTaichi / initGPU call here!
        // The water will automatically init itself the moment the Engine builds the BVH.

        // 2. Create a "Pool Floor" out of a basic plane
        let poolTris = [[[-6, -1.5, -6], [6, -1.5, -6], [6, -1.5, 6], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0], [1, 0], [1, 1]],
        [[-6, -1.5, -6], [6, -1.5, 6], [-6, -1.5, 6], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0], [1, 1], [0, 1]]
        ];
        this.pool = new MeshObject(poolTris, false);
        this.pool.set_material([0.2, 0.6, 0.8], 0.2);

        // 3. Add a couple of floating spheres for refraction aesthetic
        this.sphere1 = new Sphere(1.5).make_interactable();
        this.sphere1.position = [-2.0, 0.0, -1.5];
        this.sphere1.set_material([1.0, 0.2, 0.3], 0.9, 0.0); // Shiny red

        this.sphere2 = new Sphere(1.0).make_interactable();
        this.sphere2.position = [2.5, 0.5, 2.0];
        this.sphere2.set_material([1.0, 1.0, 1.0], 1.0, 0.8, 1.5); // Glass
    }

    async construct() {
        // Set up the Camera looking down at the pool
        this.camera.pos = [0.0, 4.5, 9.0];
        this.camera.dir = Math3D.normalize(Math3D.sub([0.0, 0.0, 0.0], this.camera.pos));
        this.camera.skyColor = [0.05, 0.05, 0.08]; // Darker dramatic sky
        this.camera.skyIntensity = 1.5;
        this.camera.giMultiplier = 1.2;

        // Add meshes to scene. The engine will now build the BVH, 
        // and NativeGPUWater will automatically bind to it on the first frame!
        this.add(this.pool, this.water, this.sphere1, this.sphere2);
    }
}

export class TaichiWaterScene extends Scene {
    async setup() {
        // 1. Initialize the Taichi Water
        this.water = new TaichiWater(45, 12.0);
        await this.water.initTaichi(this.engine);

        // 2. Create a "Pool Floor" out of a basic plane
        let poolTris = [[[-6, -1.5, -6], [6, -1.5, -6], [6, -1.5, 6], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0], [1, 0], [1, 1]],
        [[-6, -1.5, -6], [6, -1.5, 6], [-6, -1.5, 6], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 0], [1, 1], [0, 1]]
        ];
        this.pool = new MeshObject(poolTris, false);
        // Tiled checkerboard-like blue tiles
        this.pool.set_material([0.2, 0.6, 0.8], 0.2);

        // 3. Add a couple of floating spheres for refraction aesthetic
        this.sphere1 = new Sphere(1.5).make_interactable();
        this.sphere1.position = [-2.0, 0.0, -1.5];
        this.sphere1.set_material([1.0, 0.2, 0.3], 0.9, 0.0); // Shiny red

        this.sphere2 = new Sphere(1.0).make_interactable();
        this.sphere2.position = [2.5, 0.5, 2.0];
        this.sphere2.set_material([1.0, 1.0, 1.0], 1.0, 0.8, 1.5); // Glass
    }

    async construct() {
        // Set up the Camera looking down at the pool
        this.camera.pos = [0.0, 4.5, 9.0];
        this.camera.dir = Math3D.normalize(Math3D.sub([0.0, 0.0, 0.0], this.camera.pos));
        this.camera.skyColor = [0.05, 0.05, 0.08]; // Darker dramatic sky
        this.camera.skyIntensity = 1.5;
        this.camera.giMultiplier = 1.2;

        // Provide the meshes to the path tracer
        this.water.scene = this;
        this.add(this.pool, this.water, this.sphere1, this.sphere2);
    }
}



// ==========================================
// Helper Classes for Voxel Room Scene
// ==========================================
// Generates perfectly flat-shaded box triangles with UV scaling
function createBoxTris(w, h, d, tileU = 1, tileV = 1) {
    let x = w / 2, y = h / 2, z = d / 2;
    let p = [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], // Front
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z]  // Back
    ];
    let n = [
        [0, 0, 1], [0, 0, -1], [-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0]
    ];
    let tris = [];
    function addFace(v0, v1, v2, v3, norm, wU, hV) {
        let uv = [[0, 0], [wU * tileU, 0], [wU * tileU, hV * tileV], [0, hV * tileV]];
        tris.push([p[v0], p[v1], p[v2], norm, norm, norm, uv[0], uv[1], uv[2]]);
        tris.push([p[v0], p[v2], p[v3], norm, norm, norm, uv[0], uv[2], uv[3]]);
    }
    addFace(0, 1, 2, 3, n[0], w, h); // Front
    addFace(5, 4, 7, 6, n[1], w, h); // Back
    addFace(4, 0, 3, 7, n[2], d, h); // Left
    addFace(1, 5, 6, 2, n[3], d, h); // Right
    addFace(3, 2, 6, 7, n[4], w, d); // Top
    addFace(4, 5, 1, 0, n[5], w, d); // Bottom
    return tris;
}

// Standard Box Mesh
export class Box extends MeshObject {
    constructor(w, h, d, color, tileU = 1, tileV = 1) {
        super(createBoxTris(w, h, d, tileU, tileV), false); // false = Flat Shaded
        this.set_material(color, 0.1, 0.0, 1.5, [0, 0, 0], 0.0);
    }
}

// Pure Light Source Box
export class LightBox extends MeshObject {
    constructor(w, h, d, color, strength) {
        super(createBoxTris(w, h, d), false);
        this.set_material([0, 0, 0], 0.1, 0.0, 1.5, color, strength);
    }
}

// Procedural Texture Generators
function generateDotTexture(baseHex, dotHex) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = baseHex;
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = dotHex;
    ctx.beginPath();
    ctx.arc(64, 64, 38, 0, Math.PI * 2);
    ctx.fill();
    return canvas.toDataURL('image/png');
}

function generateSlatTexture(baseHex, lineHex) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = baseHex;
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = lineHex;
    ctx.fillRect(122, 0, 6, 128); // Wood groove
    return canvas.toDataURL('image/png');
}



export class VoxelRoomScene extends Scene {
    async setup() {
        const pegboardTex = generateDotTexture('#E67E22', '#5D3A1A');
        const bedTex = generateDotTexture('#58D68D', '#1D8348');
        const floorTex = generateSlatTexture('#D5D8DC', '#808B96');

        // 2. Floor & Walls
        this.floor = new Box(12, 0.5, 12, [1, 1, 1], 2, 2);
        this.floor.position = [0, -0.25, 0];
        this.floor.albedoUrl = floorTex;

        this.leftWall = new Box(0.5, 10, 12, [1, 1, 1], 2, 2);
        this.leftWall.position = [-6.25, 5, 0];
        this.leftWall.albedoUrl = pegboardTex;

        const wallColor = [0.85, 0.85, 0.9];
        this.rwBase = new Box(12, 1.5, 0.5, wallColor);
        this.rwBase.position = [0, 0.75, -6.25];
        this.rwTop = new Box(12, 3, 0.5, wallColor);
        this.rwTop.position = [0, 8.5, -6.25];
        this.rwP1 = new Box(3, 5.5, 0.5, wallColor);
        this.rwP1.position = [-4.5, 4.25, -6.25];
        this.rwP2 = new Box(2, 5.5, 0.5, wallColor);
        this.rwP2.position = [0, 4.25, -6.25];
        this.rwP3 = new Box(4, 5.5, 0.5, wallColor);
        this.rwP3.position = [4.0, 4.25, -6.25];

        // 3. Emissive Lights
        this.lightYellow = new LightBox(2, 5.5, 0.2, [1.0, 0.2, 0.0], 0.0);
        this.lightYellow.position = [-2.0, 4.25, -6.6];
        this.lightBlue = new LightBox(1.5, 5.5, 0.2, [0.01, 0.2, 1.0], 0.0);
        this.lightBlue.position = [1.5, 4.25, -6.6];

        // 4. Furniture
        this.bed = new Box(3.5, 0.6, 6, [1, 1, 1], 2.5, 2.5);
        this.bed.position = [-1.5, 0.3, 1.0];
        this.bed.albedoUrl = bedTex;
        this.pillow = new Box(2.5, 0.3, 1.2, [0.95, 0.95, 1.0]);
        this.pillow.position = [-1.5, 0.75, -1.0];

        const furnColor = [0.9, 0.9, 0.95];
        const deskTop = new Box(2.5, 0.2, 4.0, furnColor); deskTop.position = [-4.8, 3.0, 2.5];
        const deskLeg1 = new Box(0.2, 3.0, 0.2, furnColor); deskLeg1.position = [-3.7, 1.5, 1.0];
        const deskLeg2 = new Box(0.2, 3.0, 0.2, furnColor); deskLeg2.position = [-3.7, 1.5, 4.0];
        this.deskGroup = new Group(deskTop, deskLeg1, deskLeg2);
        // this.deskGroup.opacity = 0.5;
        // this.deskGroup.set_material(Material.TransparentNoRefraction([0.4, 0.7, 1.0], 1.0)); 

        deskTop.set_material([1, 1, 1.0], 1.0, 0.1, 0.0);

        this.shelf1 = new Box(1.5, 0.2, 3.5, furnColor); this.shelf1.position = [-5.4, 4.5, 2.5];
        this.shelf2 = new Box(1.5, 0.2, 3.5, furnColor); this.shelf2.position = [-5.4, 5.8, 2.5];
        this.cabinet = new Box(1.5, 2.5, 2.0, furnColor); this.cabinet.position = [-5.4, 7.5, -2.0];

        // 1. Blue Glass Cube
        this.cube1 = new Box(1.2, 1.2, 1.2, [0.4, 0.7, 1.0]);
        this.cube1.position = [4.0, 0.6, 1.0];
        this.cube1.make_interactable().set_name('cube1');
        // Parameters: color, smoothness, transparency, ior
        this.cube1.set_material([1, 1, 1.0], 1.0, 0.5, 1.0);

        // 2. Red Glass Cube
        this.cube2 = new Box(0.9, 0.9, 0.9, [1.0, 0.4, 0.4]);
        this.cube2.position = [3.8, 1.65, 0.9];
        this.cube2.make_interactable().set_name('cube2');
        // Using transparency of 0.9 makes it clear glass, IOR of 1.5 is the physical constant for glass
        this.cube2.set_material([1.0, 0.4, 0.4], 1.0, 0.9, 1.5);

        // --- INTERACTIVE DEMO: Draggable Desk Lamp ---
        // A glowing orb sitting on the desk. Drag it up/down to control brightness!
        this.deskLamp = new Sphere(0.35);
        this.deskLamp.position = [-4.8, 3.55, 2.5];
        this.deskLamp.set_material([1.0, 0.9, 0.7], 0.9, 0.0, 1.5, [1.0, 0.85, 0.6], 4.0);
        this.deskLamp.make_interactable().set_name('deskLamp');

        // Custom Y-axis-only drag: Moving the lamp up increases emission, down dims it
        this.deskLamp.onMouseDown = (pt, rayDir) => {
            this.deskLamp._dragStartY = pt[1];
            this.deskLamp._dragStartPosY = this.deskLamp.position[1];
            this.deskLamp._dragStartEmStrength = this.deskLamp.emStrength;
            return true;
        };
        this.deskLamp.onMouseDrag = (pt, rayDir, tHit) => {
            // Constrain to Y axis only, clamp between desk surface and ceiling
            const newY = Math.max(3.55, Math.min(8.0,
                this.deskLamp._dragStartPosY + (pt[1] - this.deskLamp._dragStartY)
            ));
            this.deskLamp.position = [
                this.deskLamp.position[0],
                newY,
                this.deskLamp.position[2]
            ];

            // Map height to emission strength: higher = brighter (range 1..12)
            const heightRatio = (newY - 3.55) / (8.0 - 3.55);
            this.deskLamp.emStrength = 1.0 + heightRatio * 11.0;
            return true;
        };
    }

    async construct() {
        // --- INITIAL CAMERA & AMBIENT ---
        this.camera.pos = [15, 12, 15];
        this.camera.dir = Math3D.normalize(Math3D.sub([0, 2, 0], this.camera.pos));
        const skyFade = new ValueTracker(2.0);
        skyFade.add_updater((v, dt) => { this.camera.skyIntensity = v.get_value(); });

        // FIX 1: Start with high sky intensity so we can see the construction
        // --- NIGHT TIME SETTINGS ---
        this.camera.pos = [15, 6, 15];
        this.camera.dir = Math3D.normalize(Math3D.sub([0, 2, 0], this.camera.pos));
        this.camera.skyColor = [0.02, 0.04, 0.1]; // Deep Night Blue (Moonlight)
        this.camera.skyIntensity = 0.4;           // Enough to see silhouettes
        this.camera.giMultiplier = 2.5;           // High GI for cozy light bounces

        // --- STEP 1: THE FLOOR & LIGHTS ---
        // FIX 2: Bring the lights in at the very beginning so they illuminate the room


        await this.play(
            new Create(this.lightYellow, { run_time: 1.0 }),
            new Create(this.lightBlue, { run_time: 1.0 })
        );
        this.play(new MoveCamera(this.camera, {
            pos: [8, 13, 12],
            dir: Math3D.normalize(Math3D.sub([-2, 2, 0], [8, 13, 12])),
            fov: 40 * Math.PI / 180,
            focusDist: 14.0
        }, { run_time: 6.0 }),
        );
        this.play(
            this.lightYellow.animate({
                run_time: 5.0,
                rate_func: rate_functions.easeIn // Glow starts slow then accelerates
            })
                .set_material([1.0, 0.6, 0.1], 0.1, 0, 1.5, [1.0, 0.2, 0.0], 8.0)
                .build(),

            this.lightBlue.animate({
                run_time: 5.0,
                rate_func: rate_functions.smooth // Gentle start and finish
            })
                .set_material([0.1, 0.4, 1.0], 0.1, 0, 1.5, [0.01, 0.4, 1.0], 8.0)
                .build(),

            skyFade.animate({ run_time: 6.0 }).set_value(0.2).build(),
        );
        await this.play(
            new Create(this.floor, { run_time: 1.5 }),
        );


        // // --- STEP 2: WALLS ---
        await this.play(
            new Create(this.leftWall, { run_time: 1.0 }),
            new Create(this.rwBase, { run_time: 0.5 }),
            new Create(this.rwTop, { run_time: 0.5 }),
            new Create(this.rwP1, { run_time: 0.5 }),
            new Create(this.rwP2, { run_time: 0.5 }),
            new Create(this.rwP3, { run_time: 0.5 })
        );

        // --- STEP 3: FURNITURE ASSEMBLY ---
        await this.play(
            new Create(this.bed, { run_time: 1.2, rate_func: rate_functions.easeIn }),
            new Create(this.deskGroup, { run_time: 1.2, rate_func: rate_functions.easeIn }),
            new Create(this.pillow, { run_time: 0.8 }),
            new Create(this.shelf1, { run_time: 0.5 }),
            new Create(this.shelf2, { run_time: 0.5 }),
            new Create(this.cabinet, { run_time: 0.5 })
        );

        // --- STEP 4: CINEMATIC SWEEP & LIGHT TRANSITION ---
        this.cube1.add_updater((m, dt) => m.rotate(0, dt * 1.5, 0));
        this.cube2.add_updater((m, dt) => m.rotate(dt, dt, 0));

        // --- INTERACTIVE CUBE: Click to cycle glass colors ---
        const cubeColors = [
            { color: [0.4, 0.7, 1.0], label: 'Blue' },
            { color: [0.2, 1.0, 0.5], label: 'Green' },
            { color: [1.0, 0.85, 0.2], label: 'Gold' },
            { color: [0.9, 0.3, 1.0], label: 'Purple' },
        ];
        let cube1ColorIdx = 0;
        this.cube1.onMouseDown = (pt) => {
            cube1ColorIdx = (cube1ColorIdx + 1) % cubeColors.length;
            const c = cubeColors[cube1ColorIdx].color;
            this.cube1.set_material(c, 1.0, 0.9, 1.5);
            console.log(`🔷 Cube 1 → ${cubeColors[cube1ColorIdx].label} glass`);
            return false; // false = click-only, no drag
        };

        const cube2Colors = [
            { color: [1.0, 0.4, 0.4], label: 'Red' },
            { color: [1.0, 1.0, 1.0], label: 'Clear' },
            { color: [0.1, 0.1, 0.1], label: 'Obsidian' },
        ];
        let cube2ColorIdx = 0;
        this.cube2.onMouseDown = (pt) => {
            cube2ColorIdx = (cube2ColorIdx + 1) % cube2Colors.length;
            const c = cube2Colors[cube2ColorIdx].color;
            this.cube2.set_material(c, 1.0, 0.9, 1.5);
            console.log(`🔴 Cube 2 → ${cube2Colors[cube2ColorIdx].label} glass`);
            return false; // false = click-only, no drag
        };

        // FIX 3: Fade out the sky light as the camera moves in for that "cinematic" look

        await this.play(

            new Create(this.cube1, { run_time: 1.0 }),
            new Create(this.cube2, { run_time: 1.0 })
        );

        // --- STEP 5: BRING IN THE INTERACTIVE DESK LAMP ---
        await this.play(
            new Create(this.deskLamp, { run_time: 1.0 }),
        );

        // --- STEP 6: FINAL INDICATE ---
        await this.play(new Indicate(this.cube2, { run_time: 1.5 }));



        // await this.play(
        //     new MoveCamera(this.camera, {
        //         pos: [7.5, 4.5, 8.5],
        //         dir: Math3D.normalize(Math3D.sub([4.0, 1.0, 1.0], [7.5, 4.5, 8.5])),
        //         focusDist: 5.5,   // Focus specifically on the cubes
        //         aperture: 0.35,   // Increase blur depth
        //         fov: 35 * Math.PI / 180
        //     }, { 
        //         run_time: 4.0, 
        //         rate_func: rate_functions.smooth 
        //     }),
        //     new Indicate(this.cube1, { run_time: 2.0 })
        // );
        await this.wait(2.0);
    }
}

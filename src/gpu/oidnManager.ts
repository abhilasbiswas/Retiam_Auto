// @ts-nocheck

export class OIDNManager {
    constructor(engine) {
        this.engine = engine;
        this.unet = null;
        this.isProcessing = false;
        this.isInitialized = false;
        this.currentModel = null;
        this.initPromise = null;
        
        // Track what buffers the current model requires
        this.useAlbedo = false;
        this.useNormal = false;
    }

    async init(modelFilename) {
        if (this.currentModel === modelFilename && this.initPromise) return this.initPromise;
        this.isInitialized = false;
        this.currentModel = modelFilename;
        
        // Dynamically determine required buffers from the filename!
        // (This matches 'alb', 'calb', 'nrm', 'cnrm' perfectly)
        this.useAlbedo = modelFilename.includes('alb');
        this.useNormal = modelFilename.includes('nrm');
        const requiresAux = this.useAlbedo || this.useNormal;

        console.log(requiresAux)
        this.initPromise = (async () => {
            document.getElementById('status').innerText = `Status: Loading OIDN (${modelFilename})...`;
            document.getElementById('status').style.color = "#00bcd4";
            try {
                const oidn = await import('oidn-web');
                let adapterInfo = typeof this.engine.adapter.requestAdapterInfo === 'function' 
                    ? await this.engine.adapter.requestAdapterInfo() 
                    : this.engine.adapter.info;
                
                const weightUrl = `${window.location.origin}/oidn/${modelFilename}.tza`;

                this.unet = await oidn.initUNetFromURL(weightUrl, { device: this.engine.device, adapterInfo }, { aux: requiresAux, hdr: true });
                this.isInitialized = true;
                console.log(`OIDN Initialized! [Model: ${modelFilename} | Albedo: ${this.useAlbedo} | Normal: ${this.useNormal}]`);
            } catch (err) {
                console.error("Failed to initialize OIDN:", err);
                document.getElementById('status').innerText = `Status: OIDN Init Failed (${modelFilename} missing?)`;
                document.getElementById('status').style.color = "#f44336";
            }
        })();
        return this.initPromise;
    }

    async denoise(frameCount) {
        if (!this.isInitialized || this.isProcessing) return false;
        this.isProcessing = true;

        // Extracts all 3 buffers via your Compute Shader
        const buffers = await this.engine.extractOIDN(frameCount);

        return new Promise((resolve) => {
            let executeParams = {
                color: { data: buffers.color, width: this.engine.width, height: this.engine.height },
                done: (result) => {
                    this.engine.injectOIDN(result.data);
                    this.isProcessing = false;
                    resolve(true);
                }
            };

            // Inject the extra buffers into OIDN only if the loaded weights require them
            if (this.useAlbedo) {
                executeParams.albedo = { data: buffers.albedo, width: this.engine.width, height: this.engine.height };
            }
            if (this.useNormal) {
                executeParams.normal = { data: buffers.normal, width: this.engine.width, height: this.engine.height };
            }

            this.unet.tileExecute(executeParams);
        });
    }
}
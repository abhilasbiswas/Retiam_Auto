import React, { useEffect, useRef, useState } from 'react';
// @ts-ignore
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
// @ts-ignore
import { Settings, Layers, Box, Film, SlidersHorizontal, Settings2, Download } from 'lucide-react';
import { VoxelRoomScene, Scene, CornellBoxScene } from '../scene/scenes';

const TabContainer = ({ tabs, activeTab, onTabSelect, children }: any) => (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: '#111' }}>
        <div style={{ display: 'flex', background: '#181818', borderBottom: '1px solid #2a2a2a', userSelect: 'none' }}>
            {tabs.map((t: any) => (
                <div key={t.id} onClick={() => onTabSelect(t.id)}
                    style={{
                        padding: '6px 14px', fontSize: '10px', cursor: 'pointer', fontWeight: '600', letterSpacing: '0.5px',
                        borderTop: activeTab === t.id ? '2px solid #6366f1' : '2px solid transparent',
                        background: activeTab === t.id ? '#111' : 'transparent',
                        color: activeTab === t.id ? '#ccc' : '#666',
                        display: 'flex', alignItems: 'center', gap: '6px'
                    }}>
                    {t.icon} {t.label.toUpperCase()}
                </div>
            ))}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            {children}
        </div>
    </div>
);

export default function App() {
    const isInit = useRef(false);
    const sceneRef = useRef<Scene | null>(null);

    // Left Tabs: 'outliner', 'assets'
    const [leftTab, setLeftTab] = useState('outliner');

    // Bottom Tabs: 'timeline', 'interactions'
    const [bottomTab, setBottomTab] = useState('timeline');

    // Right Tabs: 'inspector', 'engine', 'export'
    const [rightTab, setRightTab] = useState('engine');

    // Engine UI States
    const [status] = useState("Status: Initializing UI...");
    const [frames] = useState("Realtime Samples: 0");
    const [mobjects, setMobjects] = useState<any[]>([]);
    const [selectedObject, setSelectedObject] = useState<any>(null);
    const [, setTickCounter] = useState(0);

    useEffect(() => {
        if (!isInit.current) {
            isInit.current = true;
            const bootEngine = async () => {
                console.log("WebGPU React Engine Booting...");
                const scene = new CornellBoxScene();
                sceneRef.current = scene;
                try {
                    if (document.getElementById('canvas')) await scene.run();
                } catch (e) { console.error("Boot error:", e); }
            };
            bootEngine();
        }

        const handleMobjectsUpdated = () => {
            // @ts-ignore
            if (window._scene_mobjects) setMobjects([...window._scene_mobjects]);
        };

        const handlePlaybackTick = () => {
            // Just force a re-render so React reads the raw mutated properties from the engine's heap
            setTickCounter(c => c + 1);
        };

        window.addEventListener('mobjects-updated', handleMobjectsUpdated);
        window.addEventListener('playback-tick', handlePlaybackTick);

        // Sync initial state if engine already booted
        // @ts-ignore
        if (window._scene_mobjects) setMobjects([...window._scene_mobjects]);

        return () => {
            window.removeEventListener('mobjects-updated', handleMobjectsUpdated);
            window.removeEventListener('playback-tick', handlePlaybackTick);
        };
    }, []);

    // Recursive component to render scene graph nodes
    const TreeNode = ({ node, depth }: { node: any, depth: number }) => {
        const isSelected = selectedObject === node;
        let icon = '⬡';
        if (node.radius) icon = '⭕';
        else if (node.isVector) icon = '📝';
        else if (node.isMorphing) icon = '💧';

        let name = node.name || (node.isMorphing ? "Morph Target" : (node.triangles ? "Polygonal Mesh" : (node.radius ? "Analytic Sphere" : "Group")));

        return (
            <div>
                <div
                    onClick={() => { setSelectedObject(node); setRightTab('inspector'); }}
                    style={{
                        padding: `4px 8px 4px ${depth * 16 + 8}px`, cursor: 'pointer',
                        background: isSelected ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
                        borderLeft: isSelected ? '3px solid #6366f1' : '3px solid transparent',
                        color: isSelected ? '#a5b4fc' : '#aaa',
                        display: 'flex', alignItems: 'center', fontSize: '11px', transition: 'background 0.1s',
                        userSelect: 'none'
                    }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                >
                    <span style={{ marginRight: '6px', fontSize: '10px' }}>{icon}</span>
                    {name}
                </div>
                {node.children && node.children.length > 0 && (
                    <div>{node.children.map((child: any, idx: number) => <TreeNode key={idx} node={child} depth={depth + 1} />)}</div>
                )}
            </div>
        );
    };

    const updateObjectProp = (prop: string, val: number, index?: number) => {
        if (!selectedObject || !sceneRef.current) return;

        if (index !== undefined) {
            selectedObject[prop][index] = val;
        } else if (prop.startsWith('mat.')) {
            const key = prop.split('.')[1];
            selectedObject.material[key] = val;
        } else if (prop.startsWith('matColor.')) {
            const key = prop.split('.')[1];
            const cIdx = parseInt(key);
            selectedObject.material.color[cIdx] = val;
        } else {
            selectedObject[prop] = val;
        }

        if (selectedObject.triangles) selectedObject.bvhDirty = true;
        (sceneRef.current as any).frameCount = 0;

        setSelectedObject({ ...selectedObject } as any);
        setTimeout(() => setSelectedObject(selectedObject), 0);
    };

    const [activeMenu, setActiveMenu] = useState<string | null>(null);

    // Click outside handler for menus
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (activeMenu) setActiveMenu(null);
        };
        document.addEventListener('click', handleClickOutside);
        return () => document.removeEventListener('click', handleClickOutside);
    }, [activeMenu]);

    const MenuDropdown = ({ label, items }: { label: string, items: { name: string, shortcut: string }[] }) => {
        const isOpen = activeMenu === label;
        return (
            <div style={{ position: 'relative' }} onClick={(e) => { e.stopPropagation(); setActiveMenu(isOpen ? null : label); }}>
                <span style={{
                    cursor: 'pointer', padding: '4px 8px', borderRadius: '4px',
                    background: isOpen ? '#333' : 'transparent',
                    color: isOpen ? '#fff' : '#aaa'
                }}>
                    {label}
                </span>
                {isOpen && (
                    <div style={{
                        position: 'absolute', top: '100%', left: 0, marginTop: '4px',
                        background: '#1f1f1f', border: '1px solid #333', borderRadius: '4px',
                        padding: '4px 0', minWidth: '180px', zIndex: 1000,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
                    }}>
                        {items.map((item, idx) => (
                            <div key={idx} style={{
                                padding: '6px 16px', fontSize: '11px', color: '#ccc',
                                display: 'flex', justifyContent: 'space-between',
                                cursor: 'pointer'
                            }}
                                onMouseEnter={e => e.currentTarget.style.background = '#6366f1'}
                                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                onClick={(e) => { e.stopPropagation(); setActiveMenu(null); }}>
                                <span>{item.name}</span>
                                <span style={{ color: '#888' }}>{item.shortcut}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0a0a0a', color: '#e0e0e0', fontFamily: 'Inter, sans-serif' }}>
            {/* TOP MENU BAR */}
            <div style={{ position: 'relative', zIndex: 9999, height: '35px', background: '#1c1c1c', borderBottom: '1px solid #111', display: 'flex', alignItems: 'center', padding: '0 12px', fontSize: '12px', fontWeight: '500', color: '#aaa', userSelect: 'none' }}>
                <span style={{ color: '#6366f1', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Film size={14} /> Retiam Cinema
                </span>
                <div style={{ margin: '0 16px', display: 'flex', gap: '8px' }}>
                    <MenuDropdown label="File" items={[
                        { name: 'New Project', shortcut: '⌘N' },
                        { name: 'Open Scene...', shortcut: '⌘O' },
                        { name: 'Save', shortcut: '⌘S' },
                        { name: 'Import Asset', shortcut: '⌘I' },
                        { name: 'Export As...', shortcut: '⇧⌘E' }
                    ]} />
                    <MenuDropdown label="Edit" items={[
                        { name: 'Undo', shortcut: '⌘Z' },
                        { name: 'Redo', shortcut: '⇧⌘Z' },
                        { name: 'Settings', shortcut: '⌘,' }
                    ]} />
                    <MenuDropdown label="View" items={[
                        { name: 'Toggle Fullscreen', shortcut: 'F11' },
                        { name: 'Reset Layout', shortcut: '' }
                    ]} />
                    <MenuDropdown label="Help" items={[
                        { name: 'WebGPU Documentation', shortcut: '' },
                        { name: 'About Retiam', shortcut: '' }
                    ]} />
                </div>
            </div>

            <PanelGroup orientation="horizontal">
                {/* LEFT PANEL */}
                <Panel defaultSize={15} minSize={10} style={{ borderRight: '1px solid #222' }}>
                    <TabContainer
                        activeTab={leftTab} onTabSelect={setLeftTab}
                        tabs={[{ id: 'outliner', label: 'Outliner', icon: <Layers size={12} /> }, { id: 'assets', label: 'Assets', icon: <Box size={12} /> }]}
                    >
                        {leftTab === 'outliner' ? (
                            <div style={{ padding: '8px 0' }}>
                                {mobjects.length === 0 ? (
                                    <div style={{ padding: '12px', fontSize: '11px', color: '#555' }}>Loading hierarchy...</div>
                                ) : (
                                    mobjects.map((m, i) => <TreeNode key={i} node={m} depth={0} />)
                                )}
                            </div>
                        ) : (
                            <div style={{ padding: '16px', fontSize: '11px', color: '#666', textAlign: 'center' }}>Asset Browser<br /><br />(Materials and Decals will appear here)</div>
                        )}
                    </TabContainer>
                </Panel>

                <PanelResizeHandle className="ResizeHandleHorizontal" />

                {/* CENTER AREA */}
                <Panel defaultSize={65} minSize={30}>
                    <PanelGroup orientation="vertical">
                        {/* VIEWPORT */}
                        <Panel defaultSize={70} minSize={20} style={{ position: 'relative', background: '#000' }}>
                            <div id="viewport-container" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
                                <canvas id="canvas" style={{ width: '100%', height: '100%', display: 'block' }}></canvas>
                                <canvas id="gimbalCanvas" width="80" height="80" style={{ position: 'absolute', top: '16px', right: '16px', pointerEvents: 'none', zIndex: 10 }}></canvas>
                                <div style={{ position: 'absolute', bottom: '16px', left: '16px', padding: '6px 12px', background: 'rgba(0,0,0,0.6)', borderRadius: '4px', backdropFilter: 'blur(4px)' }}>
                                    <div id="status" style={{ fontSize: '10px', color: '#9e9e9e', marginBottom: '2px' }}>{status}</div>
                                    <div id="frames" style={{ fontSize: '11px', color: '#fff' }}>{frames}</div>
                                    <div id="denoiseUI" style={{ fontSize: '9px', fontWeight: 'bold', marginTop: '2px', color: '#777' }}>Denoiser: OFF</div>
                                </div>
                            </div>
                        </Panel>

                        <PanelResizeHandle className="ResizeHandleVertical" />

                        {/* BOTTOM AREA */}
                        <Panel defaultSize={30} minSize={10} style={{ borderTop: '1px solid #222' }}>
                            <TabContainer
                                activeTab={bottomTab} onTabSelect={setBottomTab}
                                tabs={[{ id: 'timeline', label: 'Global Video Timeline' }, { id: 'interactions', label: 'Interaction Sequencer' }]}
                            >
                                <div style={{ display: bottomTab === 'timeline' ? 'block' : 'none', height: '100%' }}>
                                    <div id="timeline-panel" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                            <button id="btnPlay" style={btnStyle}>▶ Play</button>
                                            <button id="btnStop" style={btnStyle}>■ Stop</button>
                                            <button id="btnLoop" style={btnStyle}>🔁 Loop</button>
                                            <div style={{ width: '1px', height: '20px', background: '#333' }}></div>
                                            <button id="btnPresentation" style={{ ...btnStyle, color: '#f59e0b', borderColor: 'rgba(245, 158, 11, 0.3)' }}>📽 Presentation</button>
                                            <button id="btnStopPresentation" style={btnStyle} disabled>⏹ Stop</button>
                                            <div style={{ width: '1px', height: '20px', background: '#333' }}></div>
                                            <span style={labelStyle}>IN:</span><input id="inpLoopStart" type="number" defaultValue="0.0" step="0.5" min="0" style={inputStyle} />
                                            <span style={labelStyle}>OUT:</span><input id="inpLoopEnd" type="number" defaultValue="15.0" step="0.5" min="0" style={inputStyle} />
                                            <div style={{ width: '1px', height: '20px', background: '#333' }}></div>
                                            <select id="selSpeed" style={inputStyle}><option value="0.5">0.5x</option><option value="1">1.0x</option><option value="2">2.0x</option></select>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                            <input id="scrubber" type="range" min="0" max="15" defaultValue="0" step="0.05" style={{ flex: 1 }} />
                                            <span id="timeDisplay" style={{ width: '50px', textAlign: 'right', fontSize: '12px', fontFamily: 'monospace', color: '#6366f1' }}>0.00s</span>
                                        </div>
                                    </div>
                                </div>

                                <div style={{ display: bottomTab === 'interactions' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
                                    <div style={{ padding: '8px 16px', display: 'flex', flexDirection: 'column', height: '100%' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingBottom: '12px', borderBottom: '1px solid #222' }}>
                                            <button id="btnRecordInteraction" style={{ ...btnStyle, color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.3)' }}>⏺ Record Live Track</button>
                                            <button id="btnStopRecord" style={btnStyle} disabled>⏹ Stop</button>
                                            <button id="btnPlayInteraction" style={btnStyle} disabled>⏯ Replay Stack</button>
                                            <div style={{ flex: 1 }}></div>
                                            <button id="btnLoadInteraction" style={btnStyle}>📂 Load Data</button>
                                            <button id="btnExportInteraction" style={{ ...btnStyle, color: '#22c55e', borderColor: 'rgba(34, 197, 94, 0.3)' }} disabled>💾 Export Multitrack Bundle</button>
                                            <button id="btnClearInteraction" style={btnStyle} disabled>🗑 Clear Memory</button>
                                            <input type="file" id="fileInteraction" accept=".json" style={{ display: 'none' }} />
                                        </div>
                                        <div id="interactionTrackList" style={{ flex: 1, overflowY: 'auto', paddingTop: '12px' }}>
                                            <div style={{ fontSize: '11px', color: '#555' }}>No tracks recorded. Press Record to begin logging pointer interactions.</div>
                                        </div>
                                    </div>
                                </div>
                            </TabContainer>
                        </Panel>
                    </PanelGroup>
                </Panel>

                <PanelResizeHandle className="ResizeHandleHorizontal" />

                {/* RIGHT PANEL */}
                <Panel defaultSize={20} minSize={15} style={{ borderLeft: '1px solid #222' }}>
                    <TabContainer
                        activeTab={rightTab} onTabSelect={setRightTab}
                        tabs={[
                            { id: 'engine', label: 'Engine', icon: <SlidersHorizontal size={12} /> },
                            { id: 'inspector', label: 'Inspector', icon: <Settings2 size={12} /> },
                            { id: 'export', label: 'Export', icon: <Download size={12} /> }
                        ]}
                    >
                        <div style={{ display: rightTab === 'inspector' ? 'block' : 'none' }}>
                            <div style={{ padding: '16px' }}>
                                {selectedObject ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                        <div style={{ fontSize: '14px', color: '#fff', paddingBottom: '8px', borderBottom: '1px solid #333', fontWeight: 600 }}>
                                            {selectedObject.name || 'Selected Mesh'}
                                        </div>
                                        <div><div style={labelStyle}>POSITION</div><div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                                            <input type="number" step="0.1" value={selectedObject.position[0]} onChange={e => updateObjectProp('position', parseFloat(e.target.value), 0)} style={coordInputStyle} />
                                            <input type="number" step="0.1" value={selectedObject.position[1]} onChange={e => updateObjectProp('position', parseFloat(e.target.value), 1)} style={coordInputStyle} />
                                            <input type="number" step="0.1" value={selectedObject.position[2]} onChange={e => updateObjectProp('position', parseFloat(e.target.value), 2)} style={coordInputStyle} />
                                        </div></div>
                                        <div><div style={labelStyle}>ROTATION</div><div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                                            <input type="number" step="0.1" value={selectedObject.rotation[0]} onChange={e => updateObjectProp('rotation', parseFloat(e.target.value), 0)} style={coordInputStyle} />
                                            <input type="number" step="0.1" value={selectedObject.rotation[1]} onChange={e => updateObjectProp('rotation', parseFloat(e.target.value), 1)} style={coordInputStyle} />
                                            <input type="number" step="0.1" value={selectedObject.rotation[2]} onChange={e => updateObjectProp('rotation', parseFloat(e.target.value), 2)} style={coordInputStyle} />
                                        </div></div>
                                        <div><div style={labelStyle}>SCALE</div><div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                                            <input type="number" step="0.1" value={selectedObject.scale[0]} onChange={e => updateObjectProp('scale', parseFloat(e.target.value), 0)} style={coordInputStyle} />
                                            <input type="number" step="0.1" value={selectedObject.scale[1]} onChange={e => updateObjectProp('scale', parseFloat(e.target.value), 1)} style={coordInputStyle} />
                                            <input type="number" step="0.1" value={selectedObject.scale[2]} onChange={e => updateObjectProp('scale', parseFloat(e.target.value), 2)} style={coordInputStyle} />
                                        </div></div>
                                        {selectedObject.material && (
                                            <>
                                                <div style={{ height: '1px', background: '#222', margin: '4px 0' }} />
                                                <div><div style={labelStyle}>MATERIAL ALBEDO</div><div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                                                    <input type="number" step="0.05" min="0" max="1" value={selectedObject.material.color[0]} onChange={e => updateObjectProp('matColor.0', parseFloat(e.target.value))} style={{ ...coordInputStyle, borderTop: '2px solid #ef4444' }} />
                                                    <input type="number" step="0.05" min="0" max="1" value={selectedObject.material.color[1]} onChange={e => updateObjectProp('matColor.1', parseFloat(e.target.value))} style={{ ...coordInputStyle, borderTop: '2px solid #22c55e' }} />
                                                    <input type="number" step="0.05" min="0" max="1" value={selectedObject.material.color[2]} onChange={e => updateObjectProp('matColor.2', parseFloat(e.target.value))} style={{ ...coordInputStyle, borderTop: '2px solid #3b82f6' }} />
                                                </div></div>
                                                <div style={rowStyle}><span>Smoothness:</span><input type="range" min="0" max="1" step="0.01" value={selectedObject.material.smoothness} onChange={e => updateObjectProp('mat.smoothness', parseFloat(e.target.value))} /></div>
                                                <div style={rowStyle}><span>Metallic:</span><input type="range" min="0" max="1" step="0.01" value={selectedObject.material.metallic} onChange={e => updateObjectProp('mat.metallic', parseFloat(e.target.value))} /></div>
                                                <div style={rowStyle}><span>Transparency:</span><input type="range" min="0" max="1" step="0.01" value={selectedObject.material.transparency} onChange={e => updateObjectProp('mat.transparency', parseFloat(e.target.value))} /></div>
                                                <div style={rowStyle}><span>IOR:</span><input type="number" step="0.05" style={{ ...inputStyle, width: '60px' }} value={selectedObject.material.ior} onChange={e => updateObjectProp('mat.ior', parseFloat(e.target.value))} /></div>
                                            </>
                                        )}
                                    </div>
                                ) : (
                                    <div style={{ color: '#666', fontSize: '11px', fontStyle: 'italic', textAlign: 'center', marginTop: '40px' }}>
                                        <Settings2 size={32} style={{ margin: '0 auto 12px', opacity: 0.2 }} />
                                        Select an object from the outliner<br />to edit its precise properties.
                                    </div>
                                )}
                            </div>
                        </div>

                        <div style={{ display: rightTab === 'engine' ? 'block' : 'none' }}>
                            <div style={{ padding: '16px' }}>
                                <button id="btnToggleRT" style={{ ...fullBtnStyle, background: '#6366f1', color: 'white', border: 'none' }}>Enable Ray Tracing (T)</button>
                                <button id="btnToggleDoF" style={{ ...fullBtnStyle, marginTop: '8px' }}>Disable Focus Blur (B)</button>

                                <div style={{ height: '1px', background: '#222', margin: '16px 0' }} />
                                <div style={{ fontSize: '11px', fontWeight: 'bold', marginBottom: '12px', color: '#888' }}>RENDER PIPELINE</div>

                                <div style={rowStyle}><span>BVH Builder:</span><select id="selBVHMethod" style={inputStyle}><option value="spatial">Spatial Median</option><option value="sah">Binned SAH</option></select></div>
                                <div style={rowStyle}><span>RT Technique:</span><select id="selRTTechnique" style={inputStyle}><option value="0">Classic Path Tracing</option><option value="1">ReSTIR GI</option><option value="2">Radiance Cascades</option></select></div>
                                <div style={rowStyle}><span>Preview Denoiser:</span><select id="selPreviewDenoiser" style={inputStyle} defaultValue="rt_hdr_alb_nrm">
                                    <option value="none">None</option>
                                    <option value="spatial">Fast Spatial</option>
                                    <optgroup label="OIDN Color Only">
                                        <option value="rt_hdr">rt_hdr.tza</option>
                                        <option value="rt_hdr_small">rt_hdr_small.tza (Fast)</option>
                                    </optgroup>
                                    <optgroup label="OIDN Color + Albedo + Normal">
                                        <option value="rt_hdr_alb_nrm">rt_hdr_alb_nrm.tza</option>
                                        <option value="rt_hdr_alb_nrm_small">rt_hdr_alb_nrm_small.tza (Fast)</option>
                                        <option value="rt_hdr_calb_cnrm_large">rt_hdr_calb_cnrm_large.tza (Clean)</option>
                                        <option value="rt_hdr_calb_cnrm">rt_hdr_calb_cnrm.tza (Clean)</option>
                                        <option value="rt_hdr_calb_cnrm_small">rt_hdr_calb_cnrm_small.tza (Fast Clean)</option>
                                    </optgroup>
                                </select></div>
                                <div style={rowStyle}><span>Sky Intensity:</span><input id="uiSkyIntensity" type="range" min="0" max="10" defaultValue="1.0" step="0.1" /><span id="skyIntensityVal" style={valStyle}>1.0</span></div>
                                <div style={rowStyle}><span>GI Multiplier:</span><input id="uiGIMultiplier" type="range" min="0" max="5" defaultValue="1.0" step="0.1" /><span id="giMultiplierVal" style={valStyle}>1.0</span></div>
                                <div style={rowStyle}><span>Preview Samples:</span><input id="inpPreviewSpp" type="number" defaultValue="4" style={inputStyle} /></div>
                                <div style={rowStyle}><span>Preview Bounces:</span><input id="inpBounces" type="number" defaultValue="5" style={inputStyle} /></div>

                                <div style={{ height: '1px', background: '#222', margin: '16px 0' }} />
                                <div style={{ fontSize: '11px', fontWeight: 'bold', marginBottom: '12px', color: '#888' }}>VIRTUAL CAMERA</div>

                                <div style={rowStyle}><span>Model:</span><select id="selCamModel" style={inputStyle}><option value="0">Perspective</option><option value="1">Orthographic</option><option value="4">2-Point Perspective</option></select></div>
                                <div id="rowFov" style={rowStyle}><span>FOV:</span><input id="uiFov" type="range" min="10" max="180" defaultValue="45" step="1" /><span id="fovVal" style={valStyle}>45°</span></div>
                                <div id="rowOrthoScale" style={{ ...rowStyle, display: 'none' }}><span>Ortho Scale:</span><input id="uiOrthoScale" type="range" min="1" max="50" defaultValue="10" /><span id="orthoScaleVal" style={valStyle}>10.0</span></div>
                                <div id="rowLensShiftX" style={rowStyle}><span>Lens Shift X:</span><input id="uiLensShiftX" type="range" min="-1" max="1" defaultValue="0" step="0.01" /><span id="lensShiftXVal" style={valStyle}>0.00</span></div>
                                <div id="rowLensShiftY" style={rowStyle}><span>Lens Shift Y:</span><input id="uiLensShiftY" type="range" min="-1" max="1" defaultValue="0" step="0.01" /><span id="lensShiftYVal" style={valStyle}>0.00</span></div>
                                <div style={rowStyle}><span>Aperture:</span><input id="uiAperture" type="range" min="0" max="1" defaultValue="0.10" step="0.01" /><span id="apertureVal" style={valStyle}>0.10</span></div>
                                <div style={rowStyle}><span>Focus Dist:</span><input id="uiFocus" type="range" min="0.1" max="30" defaultValue="10.0" step="0.1" /><span id="focusVal" style={valStyle}>10.0</span></div>
                                <button id="btnAutoFocus" style={{ ...fullBtnStyle, marginTop: '12px' }}>Trigger Auto Focus (F)</button>
                            </div>
                        </div>

                        <div style={{ display: rightTab === 'export' ? 'block' : 'none' }}>
                            <div style={{ padding: '16px' }}>
                                <div id="progressContainer" style={{ display: 'none', padding: '12px', background: '#1c1c1c', border: '1px solid #333', borderRadius: '6px', marginBottom: '16px' }}>
                                    <div id="progressText" style={{ fontSize: '11px', color: '#ff7043', textAlign: 'center', marginBottom: '8px' }}>Ready</div>
                                    <div id="progressBar" style={{ height: '4px', background: '#000', borderRadius: '2px', overflow: 'hidden' }}>
                                        <div id="progressFill" style={{ height: '100%', background: '#ff5722', width: '0%' }}></div>
                                    </div>
                                </div>

                                <div style={rowStyle}><span>Resolution:</span><select id="selResolution" style={inputStyle} defaultValue="1280x720"><option value="720x480">720 x 480</option><option value="1280x720">1280 x 720</option><option value="1920x1080">1920 x 1080</option></select></div>
                                <div style={rowStyle}><span>Tile Size:</span><select id="selTileSize" style={inputStyle} defaultValue="0"><option value="0">Disable Tiling</option><option value="256">256 x 256</option></select></div>
                                <div style={rowStyle}><span>Denoiser:</span><select id="selOfflineDenoiser" style={inputStyle} defaultValue="rt_hdr_alb_nrm">
                                    <option value="none">None</option>
                                    <option value="spatial">Fast Spatial</option>
                                    <optgroup label="OIDN Color Only">
                                        <option value="rt_hdr">rt_hdr.tza</option>
                                        <option value="rt_hdr_small">rt_hdr_small.tza (Fast)</option>
                                    </optgroup>
                                    <optgroup label="OIDN Color + Albedo + Normal">
                                        <option value="rt_hdr_alb_nrm">rt_hdr_alb_nrm.tza</option>
                                        <option value="rt_hdr_alb_nrm_small">rt_hdr_alb_nrm_small.tza (Fast)</option>
                                        <option value="rt_hdr_calb_cnrm_large">rt_hdr_calb_cnrm_large.tza (Clean)</option>
                                        <option value="rt_hdr_calb_cnrm">rt_hdr_calb_cnrm.tza (Clean)</option>
                                        <option value="rt_hdr_calb_cnrm_small">rt_hdr_calb_cnrm_small.tza (Fast Clean)</option>
                                    </optgroup>
                                </select></div>
                                <div style={rowStyle}><span>Max Bounces:</span><input id="inpOfflineBounces" type="number" defaultValue="5" style={inputStyle} /></div>
                                <div style={rowStyle}><span>FPS:</span><input id="inpFps" type="number" defaultValue="30" style={inputStyle} /></div>
                                <div style={rowStyle}><span>Duration (s):</span><input id="inpDur" type="number" defaultValue="15" style={inputStyle} /></div>
                                <div style={rowStyle}><span>Samples/Frame:</span><input id="inpSpp" type="number" defaultValue="128" style={inputStyle} /></div>
                                <div style={rowStyle}><span>Use Interaction:</span><input id="chkUseInteraction" type="checkbox" /></div>

                                <button id="btnRender" style={{ ...fullBtnStyle, background: '#10b981', color: '#fff', marginTop: '24px', border: 'none', padding: '12px' }}>Start Offline Render</button>
                            </div>
                        </div>
                    </TabContainer>
                </Panel>
            </PanelGroup>
        </div>
    );
}

// Inline styles
const btnStyle: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid transparent',
    color: '#ccc',
    borderRadius: '4px',
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 600,
    transition: 'all 0.15s ease'
};

const fullBtnStyle: React.CSSProperties = {
    background: '#222',
    border: '1px solid #333',
    color: '#ccc',
    borderRadius: '6px',
    padding: '8px',
    cursor: 'pointer',
    fontSize: '11px',
    width: '100%',
    textAlign: 'center',
    fontWeight: 'bold',
    transition: 'all 0.2s'
};

const labelStyle: React.CSSProperties = {
    fontSize: '10px',
    color: '#777',
    fontWeight: 'bold',
    letterSpacing: '0.5px'
};

const inputStyle: React.CSSProperties = {
    background: '#0a0a0a',
    border: '1px solid #222',
    color: '#eee',
    borderRadius: '4px',
    padding: '4px 6px',
    fontSize: '11px',
    width: '90px',
    outline: 'none'
};

const coordInputStyle: React.CSSProperties = {
    ...inputStyle,
    flex: 1,
    width: '100%',
    textAlign: 'center',
    fontFamily: 'monospace'
};

const rowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: '8px',
    fontSize: '11px',
    color: '#aaa'
};

const valStyle: React.CSSProperties = {
    fontFamily: 'monospace',
    color: '#6366f1',
    minWidth: '35px',
    textAlign: 'right'
};

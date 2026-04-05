// @ts-nocheck

export function populateSceneGraph(mobjects) {
    if (typeof window !== 'undefined') {
        window._scene_mobjects = mobjects;
        window.dispatchEvent(new CustomEvent('mobjects-updated'));
    }
}

export function drawGimbal(camera) {
    const canvas = document.getElementById('gimbalCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cx = canvas.width / 2; const cy = canvas.height / 2; const radius = 25;
    const project = (wx, wy, wz) => {
        const x = wx * camera.right[0] + wy * camera.right[1] + wz * camera.right[2];
        const y = -(wx * camera.up[0] + wy * camera.up[1] + wz * camera.up[2]);
        const z = wx * camera.dir[0] + wy * camera.dir[1] + wz * camera.dir[2];
        return { x: cx + x * radius, y: cy + y * radius, z };
    };
    const axes = [{ name: 'X', color: '#ff5252', p: project(1, 0, 0) }, { name: 'Y', color: '#4caf50', p: project(0, 1, 0) }, { name: 'Z', color: '#448aff', p: project(0, 0, 1) }];
    axes.sort((a, b) => a.p.z - b.p.z);
    ctx.lineWidth = 2.5; ctx.lineCap = "round";
    axes.forEach(axis => {
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(axis.p.x, axis.p.y); ctx.strokeStyle = axis.color; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = "bold 10px monospace"; ctx.fillText(axis.name, axis.p.x + (axis.p.x > cx ? 4 : -10), axis.p.y + (axis.p.y > cy ? 10 : -4));
    });
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
}
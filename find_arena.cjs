const fs = require('fs');
const lines = fs.readFileSync('src/original_engine.html', 'utf-8').split('\n');
for (let i = 764; i < lines.length; i++) {
    if (lines[i].includes('// Editor Helper Functions (Outliner & Gimbal)')) {
        console.log(`Ends before ${i + 1}`);
        break;
    }
}

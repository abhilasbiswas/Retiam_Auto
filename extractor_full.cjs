const fs = require('fs');
const content = fs.readFileSync('src/original_engine.html', 'utf-8');

const match = content.match(/<script>(.*?)<\/script>/s);
if (match) {
    fs.writeFileSync('src/full_script.ts', match[1]);
    console.log("Full script extracted");
}

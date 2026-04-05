const fs = require('fs');
const path = require('path');

const content = fs.readFileSync(path.join(__dirname, 'src/original_engine.html'), 'utf-8');

// The WGSL strings are inside wgsl_common and shaders = { ... }
const wgslCommonMatch = content.match(/const wgsl_common = `([\s\S]*?)`;/);
const wgslCommon = wgslCommonMatch ? wgslCommonMatch[1] : '';

fs.writeFileSync(path.join(__dirname, 'src/shaders/common.wgsl'), wgslCommon);

// The rest of the shaders are in `const shaders = { ... }` block
// We can use a regex to find all keys and their backtick strings inside the `const shaders = {` block up to `};`
const shadersBlockMatch = content.match(/const shaders = {([\s\S]*?)\n            };/);

if (shadersBlockMatch) {
    const shadersBlock = shadersBlockMatch[1];
    const shaderRegex = /([a-zA-Z0-9_]+):\s*(?:wgsl_common \+\s*)?`([\s\S]*?)`/g;
    
    let match;
    while ((match = shaderRegex.exec(shadersBlock)) !== null) {
        const name = match[1];
        const source = match[2];
        const fullSource = shadersBlock.substring(match.index).startsWith(name + ': wgsl_common +') 
            ? `${wgslCommon}\n${source}` 
            : source;
            
        fs.writeFileSync(path.join(__dirname, `src/shaders/${name}.wgsl`), source);
        console.log(`Extracted src/shaders/${name}.wgsl`);
    }
}

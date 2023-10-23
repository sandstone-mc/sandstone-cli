const { fork } = require('child_process')
const path = require('path')

console.log(process.argv)
const foo = fork(path.join(__dirname, '..', 'lib', 'index.js'), process.argv.slice(2), {
    stdio: 'pipe',
    env: {
        NODE_OPTIONS: "--loader ts-node/esm"
    }
})

foo.stdout.on('data', (data) => process.stdout.write(data))

foo.stderr.on('data', (data) => process.stderr.write(data))

process.stdin.setRawMode(true)

process.stdin.on('keypress', (str, key) => {
    // "Raw" mode so we must do our own kill switch
    if(key.sequence === '\u0003') {
        process.exit();
    } else {
        foo.stdin.write(str)
    }
});
const fs = require('fs-extra')

fs.copy('./src/template', './lib/template', {
  recursive: true,
  overwrite: true,
})
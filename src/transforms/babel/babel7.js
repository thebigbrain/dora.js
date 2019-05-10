const babel = require('@babel/core');

async function babel7(asset, options) {
  let config = options.config || {};

  // If this is an internally generated config, use our internal @babel/core,
  // otherwise require a local version from the package we're compiling.
  let pkg = await asset.getPackage();

  config.code = false;
  config.ast = true;
  config.filename = asset.name;
  config.cwd = pkg ? pkg.pkgdir : asset.options.rootDir;
  config.babelrc = false;
  config.configFile = false;
  config.parserOpts = Object.assign({}, config.parserOpts, {
    allowReturnOutsideFunction: true,
    strictMode: true,
    sourceType: 'module',
    plugins: [
      "@babel/plugin-transform-runtime",
      {
        "absoluteRuntime": false,
        "corejs": false,
        "helpers": true,
        "regenerator": true,
        "useESModules": false
      }
    ]
  });

  let res;
  if (asset.ast) {
    res = babel.transformFromAst(asset.ast, asset.contents, config);
  } else {
    res = babel.transformSync(asset.contents, config);
  }

  if (res.ast) {
    asset.ast = res.ast;
    asset.isAstDirty = true;
  }
}

module.exports = babel7;

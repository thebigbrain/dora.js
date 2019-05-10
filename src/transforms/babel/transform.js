// const babel6 = require('./babel6');
const babel7 = require('./babel7');
const getBabelConfig = require('./config');

async function babelTransform(asset) {
  let config = await getBabelConfig(asset);

  await babel7(asset, config);

  return asset.ast;
}

module.exports = babelTransform;

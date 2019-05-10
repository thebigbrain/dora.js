const fs = require('@parcel/fs');
const Resolver = require('./Resolver');
const Parser = require('./Parser');
const WorkerFarm = require('@parcel/workers');
const Path = require('path');
const Bundle = require('./Bundle');
const FSCache = require('./FSCache');
const {EventEmitter} = require('events');
const logger = require('@parcel/logger');
const PackagerRegistry = require('./packagers');
const localRequire = require('./utils/localRequire');
const config = require('./utils/config');
const loadEnv = require('./utils/env');
const PromiseQueue = require('./utils/PromiseQueue');
const installPackage = require('./utils/installPackage');
const bundleReport = require('./utils/bundleReport');
const prettifyTime = require('./utils/prettifyTime');
const getRootDir = require('./utils/getRootDir');
const {glob} = require('./utils/glob');


async function throwDepError(asset, dep, err) {
  // Generate a code frame where the dependency was used
  if (dep.loc) {
    await asset.loadIfNeeded();
    err.loc = dep.loc;
    err = asset.generateErrorMessage(err);
  }

  err.fileName = asset.name;
  throw err;
}

/**
 * The Bundler is the main entry point. It resolves and loads assets,
 * creates the bundle tree, and manages the worker farm, cache, and file watcher.
 */
class Bundler extends EventEmitter {
  constructor(entryFiles, options = {}) {
    super();

    entryFiles = Bundler.normalizeEntries(entryFiles);
    this.entryFiles = this.findEntryFiles(entryFiles);
    this.options = this.normalizeOptions(options);

    this.resolver = new Resolver(this.options);
    this.parser = new Parser(this.options);
    this.packagers = new PackagerRegistry(this.options);
    this.cache = this.options.cache ? new FSCache(this.options) : null;
    this.bundleLoaders = {};

    this.addBundleLoader('wasm', {
      browser: require.resolve('./builtins/loaders/browser/wasm-loader'),
      node: require.resolve('./builtins/loaders/node/wasm-loader')
    });
    this.addBundleLoader('css', {
      browser: require.resolve('./builtins/loaders/browser/css-loader'),
      node: require.resolve('./builtins/loaders/node/css-loader')
    });
    this.addBundleLoader('js', {
      browser: require.resolve('./builtins/loaders/browser/js-loader'),
      node: require.resolve('./builtins/loaders/node/js-loader')
    });
    this.addBundleLoader('html', {
      browser: require.resolve('./builtins/loaders/browser/html-loader'),
      node: require.resolve('./builtins/loaders/node/html-loader')
    });

    this.pending = false;
    this.loadedAssets = new Map();

    this.farm = null;
    this.hmr = null;
    this.error = null;
    this.buildQueue = new PromiseQueue(this.loadAsset.bind(this));

    this.entryAssets = null;

    logger.setOptions(this.options);
  }

  static normalizeEntries(entryFiles) {
    // Support passing a single file
    if (entryFiles && !Array.isArray(entryFiles)) {
      entryFiles = [entryFiles];
    }

    // If no entry files provided, resolve the entry point from the current directory.
    if (!entryFiles || entryFiles.length === 0) {
      entryFiles = [process.cwd()];
    }

    return entryFiles;
  }

  findEntryFiles(entryFiles) {
    // Match files as globs
    return entryFiles
      .reduce((p, m) => p.concat(glob.sync(m)), [])
      .map(f => Path.resolve(f));
  }

  normalizeOptions(options) {
    const isProduction =
      options.production || process.env.NODE_ENV === 'production';
    const publicURL = options.publicUrl || options.publicURL || '/';

    const target = options.target || 'browser';

    const scopeHoist =
      options.scopeHoist !== undefined ? options.scopeHoist : false;
    return {
      production: isProduction,
      outDir: Path.resolve(options.outDir || 'dist'),
      outFile: options.outFile || '',
      publicURL: publicURL,
      cache: typeof options.cache === 'boolean' ? options.cache : true,
      cacheDir: Path.resolve(options.cacheDir || '.cache'),
      killWorkers:
        typeof options.killWorkers === 'boolean' ? options.killWorkers : true,
      minify:
        typeof options.minify === 'boolean' ? options.minify : isProduction,
      target: target,
      bundleNodeModules:
        typeof options.bundleNodeModules === 'boolean'
          ? options.bundleNodeModules
          : false,
      logLevel: isNaN(options.logLevel) ? 3 : options.logLevel,
      entryFiles: this.entryFiles,
      rootDir: getRootDir(this.entryFiles),
      sourceMaps:
        (typeof options.sourceMaps === 'boolean' ? options.sourceMaps : true) &&
        !scopeHoist,
      detailedReport: options.detailedReport || false,
      global: options.global,
      autoinstall:
        typeof options.autoInstall === 'boolean'
          ? options.autoInstall
          : process.env.PARCEL_AUTOINSTALL === 'false'
          ? false
          : !isProduction,
      scopeHoist: scopeHoist,
      contentHash:
        typeof options.contentHash === 'boolean'
          ? options.contentHash
          : isProduction,
      throwErrors:
        typeof options.throwErrors === 'boolean' ? options.throwErrors : true
    };
  }

  addAssetType(extension, path) {
    if (typeof path !== 'string') {
      throw new Error('Asset type should be a module path.');
    }

    if (this.farm) {
      throw new Error('Asset types must be added before bundling.');
    }

    this.parser.registerExtension(extension, path);
  }

  addPackager(type, packager) {
    if (this.farm) {
      throw new Error('Packagers must be added before bundling.');
    }

    this.packagers.add(type, packager);
  }

  addBundleLoader(type, paths) {
    if (typeof paths === 'string') {
      paths = {node: paths, browser: paths};
    } else if (typeof paths !== 'object') {
      throw new Error('Bundle loaders should be an object.');
    }

    for (const target in paths) {
      if (target !== 'node' && target !== 'browser') {
        throw new Error(`Unknown bundle loader target "${target}".`);
      }

      if (typeof paths[target] !== 'string') {
        throw new Error('Bundle loader should be a string.');
      }
    }

    if (this.farm) {
      throw new Error('Bundle loaders must be added before bundling.');
    }

    this.bundleLoaders[type] = paths;
  }

  async loadPlugins() {
    let relative = Path.join(this.options.rootDir, 'index');
    let pkg = await config.load(relative, ['package.json']);
    if (!pkg) {
      return;
    }

    let lastDep;
    try {
      let deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
      for (let dep in deps) {
        lastDep = dep;
        const pattern = /^(@.*\/)?parcel-plugin-.+/;
        if (pattern.test(dep)) {
          let plugin = await localRequire(dep, relative);
          await plugin(this);
        }
      }
    } catch (err) {
      logger.warn(
        `Plugin ${lastDep} failed to initialize: ${err.stack ||
        err.message ||
        err}`
      );
    }
  }

  waitForPending() {
    if (this.pending) {
      return new Promise((resolve, reject) => {
        this.once('buildEnd', () => {
          this.bundle().then(resolve, reject);
        });
      });
    }
  }

  async initialBundle(isInitialBundle) {
    await fs.mkdirp(this.options.outDir);

    this.entryAssets = new Set();
    for (let entry of this.entryFiles) {
      try {
        let asset = await this.resolveAsset(entry);
        this.buildQueue.add(asset);
        this.entryAssets.add(asset);
      } catch (err) {
        throw new Error(
          `Cannot resolve entry "${entry}" from "${this.options.rootDir}"`
        );
      }
    }

    if (this.entryAssets.size === 0) {
      throw new Error('No entries found.');
    }
  }

  async bundle() {
    // If another bundle is already pending, wait for that one to finish and retry.
    await this.waitForPending();

    let startTime = Date.now();
    this.pending = true;
    this.error = null;

    logger.clear();
    logger.progress('Building...');

    try {
      // Start worker farm, watcher, etc. if needed
      await this.start();

      // Emit start event, after bundler is initialised
      this.emit('buildStart', this.entryFiles);

      // If this is the initial bundle, ensure the output directory exists, and resolve the main asset.
      if (this.entryAssets == null) await this.initialBundle();

      // Build the queued assets.
      let loadedAssets = await this.buildQueue.run();

      logger.progress(`Producing bundles...`);

      // Create a root bundle to hold all of the entry assets, and add them to the tree.
      this.mainBundle = new Bundle();
      for (let asset of this.entryAssets) {
        this.createBundleTree(asset, this.mainBundle);
      }

      // If there is only one child bundle, replace the root with that bundle.
      if (this.mainBundle.childBundles.size === 1) {
        this.mainBundle = Array.from(this.mainBundle.childBundles)[0];
      }

      let buildTime = Date.now() - startTime;
      let time = prettifyTime(buildTime);
      logger.success(`Built in ${time}.`);

      bundleReport(this.mainBundle, this.options.detailedReport);

      this.emit('bundled', this.mainBundle);
      return this.mainBundle;
    } catch (err) {
      this.error = err;

      logger.error(err);

      this.emit('buildError', err);
    } finally {
      this.pending = false;
      this.emit('buildEnd');

      await this.stop();
    }
  }

  async start() {
    if (this.farm) {
      return;
    }

    await this.loadPlugins();

    if (!this.options.env) {
      await loadEnv(Path.join(this.options.rootDir, 'index'));
      this.options.env = process.env;
    }

    this.options.extensions = Object.assign({}, this.parser.extensions);
    this.options.bundleLoaders = this.bundleLoaders;

    this.farm = await WorkerFarm.getShared(this.options, {
      workerPath: require.resolve('./worker.js')
    });
  }

  async stop() {
    // Watcher and hmr can cause workerfarm calls
    // keep this as last to prevent unwanted errors
    if (this.farm) {
      await this.farm.end();
    }
  }

  async getAsset(name, parent) {
    let asset = await this.resolveAsset(name, parent);
    this.buildQueue.add(asset);
    await this.buildQueue.run();
    return asset;
  }

  async resolveAsset(name, parent) {
    let {path} = await this.resolver.resolve(name, parent);
    return this.getLoadedAsset(path);
  }

  getLoadedAsset(path) {
    if (this.loadedAssets.has(path)) {
      return this.loadedAssets.get(path);
    }

    let asset = this.parser.getAsset(path, this.options);
    this.loadedAssets.set(path, asset);

    return asset;
  }

  async resolveDep(asset, dep, install = true) {
    try {
      if (dep.resolved) {
        return this.getLoadedAsset(dep.resolved);
      }

      return await this.resolveAsset(dep.name, asset.name);
    } catch (err) {
      // If the dep is optional, return before we throw
      if (dep.optional) {
        return;
      }

      if (err.code === 'MODULE_NOT_FOUND') {
        let isLocalFile = /^[/~.]/.test(dep.name);
        let fromNodeModules = asset.name.includes(
          `${Path.sep}node_modules${Path.sep}`
        );

        if (
          !isLocalFile &&
          !fromNodeModules &&
          this.options.autoinstall &&
          install
        ) {
          return this.installDep(asset, dep);
        }

        err.message = `Cannot resolve dependency '${dep.name}'`;
        if (isLocalFile) {
          const absPath = Path.resolve(Path.dirname(asset.name), dep.name);
          err.message += ` at '${absPath}'`;
        }

        await throwDepError(asset, dep, err);
      }

      throw err;
    }
  }

  async installDep(asset, dep) {
    // Check if module exists, prevents useless installs
    let resolved = await this.resolver.resolveModule(dep.name, asset.name);

    // If the module resolved (i.e. wasn't a local file), but the module directory wasn't found, install it.
    if (resolved.moduleName && !resolved.moduleDir) {
      try {
        await installPackage(resolved.moduleName, asset.name, {
          saveDev: false
        });
      } catch (err) {
        await throwDepError(asset, dep, err);
      }
    }

    return this.resolveDep(asset, dep, false);
  }

  async loadAsset(asset) {
    if (asset.processed) {
      return;
    }

    if (!this.error) {
      logger.progress(`Building ${asset.basename}...`);
    }

    // Mark the asset processed so we don't load it twice
    asset.processed = true;

    // load and compile in the background
    asset.startTime = Date.now();
    let processed = await this.farm.run(asset.name);

    asset.endTime = Date.now();
    asset.buildTime = asset.endTime - asset.startTime;
    asset.id = processed.id;
    asset.generated = processed.generated;
    asset.sourceMaps = processed.sourceMaps;
    asset.hash = processed.hash;
    asset.cacheData = processed.cacheData;

    // Call the delegate to get implicit dependencies
    let dependencies = processed.dependencies;

    // console.log(dependencies);

    // Resolve and load asset dependencies
    let assetDeps = await Promise.all(
      dependencies.map(async dep => {
        if (dep.includedInParent) return null;

        dep.parent = asset.name;
        let assetDep = await this.resolveDep(asset, dep);
        if (assetDep) {
          await this.loadAsset(assetDep);
        }

        return assetDep;
      })
    );

    // If there was a processing error, re-throw now that we've set up
    // depdenency watchers. This keeps reloading working if there is an
    // error in a dependency not directly handled by Parcel.
    if (processed.error !== null) {
      throw processed.error;
    }

    // Store resolved assets in their original order
    dependencies.forEach((dep, i) => {
      asset.dependencies.set(dep.name, dep);
      let assetDep = assetDeps[i];
      if (assetDep) {
        asset.depAssets.set(dep, assetDep);
        dep.resolved = assetDep.name;
      }
    });

    logger.verbose(`Built ${asset.relativeName}...`);
  }

  createBundleTree(asset, bundle, dep, parentBundles = new Set()) {
    if (dep) {
      asset.parentDeps.add(dep);
    }

    if (asset.parentBundle && !bundle.isolated) {
      // If the asset is already in a bundle, it is shared. Move it to the lowest common ancestor.
      if (asset.parentBundle !== bundle) {
        let commonBundle = bundle.findCommonAncestor(asset.parentBundle);

        // If the common bundle's type matches the asset's, move the asset to the common bundle.
        // Otherwise, proceed with adding the asset to the new bundle below.
        if (asset.parentBundle.type === commonBundle.type) {
          this.moveAssetToBundle(asset, commonBundle);
          return;
        }
      } else {
        return;
      }

      // Detect circular bundles
      if (parentBundles.has(asset.parentBundle)) {
        return;
      }
    }

    // Skip this asset if it's already in the bundle.
    // Happens when circular dependencies are placed in an isolated bundle (e.g. a worker).
    if (bundle.isolated && bundle.assets.has(asset)) {
      return;
    }

    let isEntryAsset =
      asset.parentBundle && asset.parentBundle.entryAsset === asset;

    // If the asset generated a representation for the parent bundle type, and this
    // is not an async import, add it to the current bundle
    if (bundle.type && asset.generated[bundle.type] != null && !dep.dynamic) {
      bundle.addAsset(asset);
    }

    if ((dep && dep.dynamic) || !bundle.type) {
      // If the asset is already the entry asset of a bundle, don't create a duplicate.
      if (isEntryAsset) {
        return;
      }

      // Create a new bundle for dynamic imports
      bundle = bundle.createChildBundle(asset, dep);
    } else if (
      asset.type &&
      !this.packagers.get(asset.type).shouldAddAsset(bundle, asset)
    ) {
      // If the asset is already the entry asset of a bundle, don't create a duplicate.
      if (isEntryAsset) {
        return;
      }

      // No packager is available for this asset type, or the packager doesn't support
      // combining this asset into the bundle. Create a new bundle with only this asset.
      bundle = bundle.createSiblingBundle(asset, dep);
    } else {
      // Add the asset to the common bundle of the asset's type
      bundle.getSiblingBundle(asset.type).addAsset(asset);
    }

    // Add the asset to sibling bundles for each generated type
    if (asset.type && asset.generated[asset.type]) {
      for (let t in asset.generated) {
        if (asset.generated[t]) {
          bundle.getSiblingBundle(t).addAsset(asset);
        }
      }
    }

    asset.parentBundle = bundle;
    parentBundles.add(bundle);

    for (let [dep, assetDep] of asset.depAssets) {
      this.createBundleTree(assetDep, bundle, dep, parentBundles);
    }

    parentBundles.delete(bundle);
    return bundle;
  }

  moveAssetToBundle(asset, commonBundle) {
    // Never move the entry asset of a bundle, as it was explicitly requested to be placed in a separate bundle.
    if (
      asset.parentBundle.entryAsset === asset ||
      asset.parentBundle === commonBundle
    ) {
      return;
    }

    for (let bundle of Array.from(asset.bundles)) {
      if (!bundle.isolated) {
        bundle.removeAsset(asset);
      }
      commonBundle.getSiblingBundle(bundle.type).addAsset(asset);
    }

    let oldBundle = asset.parentBundle;
    asset.parentBundle = commonBundle;

    // Move all dependencies as well
    for (let child of asset.depAssets.values()) {
      if (child.parentBundle === oldBundle) {
        this.moveAssetToBundle(child, commonBundle);
      }
    }
  }
}

module.exports = Bundler;
Bundler.Asset = require('./Asset');
Bundler.Packager = require('./packagers/Packager');

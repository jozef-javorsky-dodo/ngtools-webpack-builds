"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AngularCompilerPlugin = void 0;
/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
const core_1 = require("@angular-devkit/core");
const node_1 = require("@angular-devkit/core/node");
const compiler_cli_1 = require("@angular/compiler-cli");
const tooling_1 = require("@angular/compiler-cli/src/tooling");
const child_process_1 = require("child_process");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const benchmark_1 = require("./benchmark");
const compiler_host_1 = require("./compiler_host");
const diagnostics_1 = require("./diagnostics");
const entry_resolver_1 = require("./entry_resolver");
const interfaces_1 = require("./interfaces");
const ngcc_processor_1 = require("./ngcc_processor");
const paths_plugin_1 = require("./paths-plugin");
const resource_loader_1 = require("./resource_loader");
const transformers_1 = require("./transformers");
const ast_helpers_1 = require("./transformers/ast_helpers");
const remove_ivy_jit_support_calls_1 = require("./transformers/remove-ivy-jit-support-calls");
const type_checker_1 = require("./type_checker");
const type_checker_messages_1 = require("./type_checker_messages");
const utils_1 = require("./utils");
const virtual_file_system_decorator_1 = require("./virtual_file_system_decorator");
const webpack_diagnostics_1 = require("./webpack-diagnostics");
const webpack_input_host_1 = require("./webpack-input-host");
const webpack_version_1 = require("./webpack-version");
class AngularCompilerPlugin {
    constructor(options) {
        this._useFactories = false;
        this._entryModule = null;
        this._transformers = [];
        this._platformTransformers = null;
        this._JitMode = false;
        this._emitSkipped = true;
        this._unusedFiles = new Set();
        this._typeDeps = new Set();
        this._changedFileExtensions = new Set(['ts', 'tsx', 'html', 'css', 'js', 'json']);
        this._nodeModulesRegExp = /[\\\/]node_modules[\\\/]/;
        // Webpack plugin.
        this._firstRun = true;
        this._donePromise = null;
        this._normalizedLocale = null;
        this._warnings = [];
        this._errors = [];
        // TypeChecker process.
        this._forkTypeChecker = true;
        this._typeCheckerProcess = null;
        this._forkedTypeCheckerInitialized = false;
        this._mainFields = [];
        this._options = Object.assign({}, options);
        this._logger = options.logger || node_1.createConsoleLogger();
        this._setupOptions(this._options);
    }
    get options() { return this._options; }
    get done() { return this._donePromise; }
    get entryModule() {
        if (!this._entryModule) {
            return null;
        }
        const splitted = this._entryModule.split(/(#[a-zA-Z_]([\w]+))$/);
        const path = splitted[0];
        const className = !!splitted[1] ? splitted[1].substring(1) : 'default';
        return { path, className };
    }
    get typeChecker() {
        const tsProgram = this._getTsProgram();
        return tsProgram ? tsProgram.getTypeChecker() : null;
    }
    _setupOptions(options) {
        benchmark_1.time('AngularCompilerPlugin._setupOptions');
        // Fill in the missing options.
        if (!options.hasOwnProperty('tsConfigPath')) {
            throw new Error('Must specify "tsConfigPath" in the configuration of @ngtools/webpack.');
        }
        // TS represents paths internally with '/' and expects the tsconfig path to be in this format
        this._tsConfigPath = utils_1.forwardSlashPath(options.tsConfigPath);
        // Check the base path.
        const maybeBasePath = path.resolve(process.cwd(), this._tsConfigPath);
        let basePath = maybeBasePath;
        if (fs.statSync(maybeBasePath).isFile()) {
            basePath = path.dirname(basePath);
        }
        if (options.basePath !== undefined) {
            basePath = path.resolve(process.cwd(), options.basePath);
        }
        // Parse the tsconfig contents.
        const { errors, rootNames, options: compilerOptions } = compiler_cli_1.readConfiguration(this._tsConfigPath, options.compilerOptions);
        if (errors && errors.length) {
            throw new Error(compiler_cli_1.formatDiagnostics(errors));
        }
        this._rootNames = rootNames;
        this._compilerOptions = compilerOptions;
        this._basePath = compilerOptions.basePath || basePath || '';
        // Overwrite outDir so we can find generated files next to their .ts origin in compilerHost.
        this._compilerOptions.outDir = '';
        this._compilerOptions.suppressOutputPathCheck = true;
        // Default plugin sourceMap to compiler options setting.
        if (!options.hasOwnProperty('sourceMap')) {
            options.sourceMap = this._compilerOptions.sourceMap || false;
        }
        // Force the right sourcemap options.
        if (options.sourceMap) {
            this._compilerOptions.sourceMap = true;
            this._compilerOptions.inlineSources = true;
            this._compilerOptions.inlineSourceMap = false;
            this._compilerOptions.mapRoot = undefined;
            // We will set the source to the full path of the file in the loader, so we don't
            // need sourceRoot here.
            this._compilerOptions.sourceRoot = undefined;
        }
        else {
            this._compilerOptions.sourceMap = false;
            this._compilerOptions.sourceRoot = undefined;
            this._compilerOptions.inlineSources = undefined;
            this._compilerOptions.inlineSourceMap = undefined;
            this._compilerOptions.mapRoot = undefined;
            this._compilerOptions.sourceRoot = undefined;
        }
        // We want to allow emitting with errors so that imports can be added
        // to the webpack dependency tree and rebuilds triggered by file edits.
        this._compilerOptions.noEmitOnError = false;
        // Set JIT (no code generation) or AOT mode.
        if (options.skipCodeGeneration !== undefined) {
            this._JitMode = options.skipCodeGeneration;
        }
        // Process i18n options.
        if (options.i18nInFile !== undefined) {
            this._compilerOptions.i18nInFile = options.i18nInFile;
        }
        if (options.i18nInFormat !== undefined) {
            this._compilerOptions.i18nInFormat = options.i18nInFormat;
        }
        if (options.i18nOutFile !== undefined) {
            this._compilerOptions.i18nOutFile = options.i18nOutFile;
        }
        if (options.i18nOutFormat !== undefined) {
            this._compilerOptions.i18nOutFormat = options.i18nOutFormat;
        }
        if (options.locale !== undefined) {
            this._compilerOptions.i18nInLocale = options.locale;
            this._compilerOptions.i18nOutLocale = options.locale;
            this._normalizedLocale = this._validateLocale(options.locale);
        }
        if (options.missingTranslation !== undefined) {
            this._compilerOptions.i18nInMissingTranslations =
                options.missingTranslation;
        }
        // For performance, disable AOT decorator downleveling transformer for applications in the CLI.
        // The transformer is not needed for VE or Ivy in this plugin since Angular decorators are removed.
        // While the transformer would make no changes, it would still need to walk each source file AST.
        this._compilerOptions.annotationsAs = 'decorators';
        // Process forked type checker options.
        if (options.forkTypeChecker !== undefined) {
            this._forkTypeChecker = options.forkTypeChecker;
        }
        // this._forkTypeChecker = false;
        // Add custom platform transformers.
        if (options.platformTransformers !== undefined) {
            this._platformTransformers = options.platformTransformers;
        }
        if (!this.options.suppressZoneJsIncompatibilityWarning &&
            this._compilerOptions.target !== undefined &&
            this._compilerOptions.target >= ts.ScriptTarget.ES2017) {
            this._warnings.push('Zone.js does not support native async/await in ES2017+.\n' +
                'These blocks are not intercepted by zone.js and will not triggering change detection.\n' +
                'See: https://github.com/angular/zone.js/pull/1140 for more information.');
        }
        if (this._compilerOptions.strictMetadataEmit) {
            this._warnings.push(`Using Angular compiler option 'strictMetadataEmit' for applications might cause undefined behavior.`);
        }
        if (!this._JitMode && !this._compilerOptions.enableIvy) {
            // Only attempt to use factories when AOT and not Ivy.
            this._useFactories = true;
        }
        // Use entryModule if available in options, otherwise resolve it from mainPath after program
        // creation.
        if (this._options.entryModule) {
            this._entryModule = this._options.entryModule;
        }
        else if (this._compilerOptions.entryModule) {
            this._entryModule = path.resolve(this._basePath, this._compilerOptions.entryModule); // temporary cast for type issue
        }
        // Set platform.
        this._platform = options.platform || interfaces_1.PLATFORM.Browser;
        // Make transformers.
        this._makeTransformers();
        benchmark_1.timeEnd('AngularCompilerPlugin._setupOptions');
    }
    _getTsProgram() {
        if (!this._program) {
            return undefined;
        }
        return this._JitMode ? this._program : this._program.getTsProgram();
    }
    updateChangedFileExtensions(extension) {
        if (extension) {
            this._changedFileExtensions.add(extension);
        }
    }
    _getChangedCompilationFiles() {
        return this._compilerHost.getChangedFilePaths()
            .filter(k => {
            for (const ext of this._changedFileExtensions) {
                if (k.endsWith(ext)) {
                    return true;
                }
            }
            return false;
        });
    }
    async _createOrUpdateProgram() {
        // Get the root files from the ts config.
        // When a new root name (like a lazy route) is added, it won't be available from
        // following imports on the existing files, so we need to get the new list of root files.
        const config = compiler_cli_1.readConfiguration(this._tsConfigPath);
        this._rootNames = config.rootNames;
        // Update the forked type checker with all changed compilation files.
        // This includes templates, that also need to be reloaded on the type checker.
        if (this._forkTypeChecker && this._typeCheckerProcess && !this._firstRun) {
            this._updateForkedTypeChecker(this._rootNames, this._getChangedCompilationFiles());
        }
        const oldTsProgram = this._getTsProgram();
        if (this._JitMode) {
            // Create the TypeScript program.
            benchmark_1.time('AngularCompilerPlugin._createOrUpdateProgram.ts.createProgram');
            this._program = ts.createProgram(this._rootNames, this._compilerOptions, this._compilerHost, oldTsProgram);
            benchmark_1.timeEnd('AngularCompilerPlugin._createOrUpdateProgram.ts.createProgram');
        }
        else {
            benchmark_1.time('AngularCompilerPlugin._createOrUpdateProgram.ng.createProgram');
            // Create the Angular program.
            this._program = compiler_cli_1.createProgram({
                rootNames: this._rootNames,
                options: this._compilerOptions,
                host: this._compilerHost,
                oldProgram: this._program,
            });
            benchmark_1.timeEnd('AngularCompilerPlugin._createOrUpdateProgram.ng.createProgram');
            benchmark_1.time('AngularCompilerPlugin._createOrUpdateProgram.ng.loadNgStructureAsync');
            await this._program.loadNgStructureAsync();
            benchmark_1.timeEnd('AngularCompilerPlugin._createOrUpdateProgram.ng.loadNgStructureAsync');
        }
        const newTsProgram = this._getTsProgram();
        const newProgramSourceFiles = newTsProgram === null || newTsProgram === void 0 ? void 0 : newTsProgram.getSourceFiles();
        const localDtsFiles = new Set(newProgramSourceFiles === null || newProgramSourceFiles === void 0 ? void 0 : newProgramSourceFiles.filter(f => f.isDeclarationFile && !this._nodeModulesRegExp.test(f.fileName)).map(f => this._compilerHost.denormalizePath(f.fileName)));
        if (!oldTsProgram) {
            // Add all non node package dts files as depedencies when not having an old program
            for (const dts of localDtsFiles) {
                this._typeDeps.add(dts);
            }
        }
        else if (oldTsProgram && newProgramSourceFiles) {
            // The invalidation should only happen if we have an old program
            // as otherwise we will invalidate all the sourcefiles.
            const oldFiles = new Set(oldTsProgram.getSourceFiles().map(sf => sf.fileName));
            const newProgramFiles = new Set(newProgramSourceFiles.map(sf => sf.fileName));
            for (const dependency of this._typeDeps) {
                // Remove type dependencies of no longer existing files
                if (!newProgramFiles.has(utils_1.forwardSlashPath(dependency))) {
                    this._typeDeps.delete(dependency);
                }
            }
            for (const fileName of newProgramFiles) {
                if (oldFiles.has(fileName)) {
                    continue;
                }
                this._compilerHost.invalidate(fileName);
                const denormalizedFileName = this._compilerHost.denormalizePath(fileName);
                if (localDtsFiles.has(denormalizedFileName)) {
                    // Add new dts file as a type depedency
                    this._typeDeps.add(denormalizedFileName);
                }
            }
        }
        // If there's still no entryModule try to resolve from mainPath.
        if (!this._entryModule && this._mainPath) {
            benchmark_1.time('AngularCompilerPlugin._make.resolveEntryModuleFromMain');
            this._entryModule = entry_resolver_1.resolveEntryModuleFromMain(this._mainPath, this._compilerHost, this._getTsProgram());
            benchmark_1.timeEnd('AngularCompilerPlugin._make.resolveEntryModuleFromMain');
        }
    }
    _createForkedTypeChecker() {
        const typeCheckerFile = './type_checker_worker.js';
        const debugArgRegex = /--inspect(?:-brk|-port)?|--debug(?:-brk|-port)/;
        const execArgv = process.execArgv.filter((arg) => {
            // Remove debug args.
            // Workaround for https://github.com/nodejs/node/issues/9435
            return !debugArgRegex.test(arg);
        });
        // Signal the process to start listening for messages
        // Solves https://github.com/angular/angular-cli/issues/9071
        const forkArgs = [type_checker_1.AUTO_START_ARG];
        const forkOptions = { execArgv };
        this._typeCheckerProcess = child_process_1.fork(path.resolve(__dirname, typeCheckerFile), forkArgs, forkOptions);
        // Handle child messages.
        this._typeCheckerProcess.on('message', message => {
            switch (message.kind) {
                case type_checker_messages_1.MESSAGE_KIND.Log:
                    const logMessage = message;
                    this._logger.log(logMessage.level, `\n${logMessage.message}`);
                    break;
                default:
                    throw new Error(`TypeChecker: Unexpected message received: ${message}.`);
            }
        });
        // Handle child process exit.
        this._typeCheckerProcess.once('exit', (_, signal) => {
            this._typeCheckerProcess = null;
            // If process exited not because of SIGTERM (see _killForkedTypeChecker), than something
            // went wrong and it should fallback to type checking on the main thread.
            if (signal !== 'SIGTERM') {
                this._forkTypeChecker = false;
                const msg = 'AngularCompilerPlugin: Forked Type Checker exited unexpectedly. ' +
                    'Falling back to type checking on main thread.';
                this._warnings.push(msg);
            }
        });
    }
    _killForkedTypeChecker() {
        if (this._typeCheckerProcess && !this._typeCheckerProcess.killed) {
            try {
                this._typeCheckerProcess.kill();
            }
            catch (_a) { }
            this._typeCheckerProcess = null;
        }
    }
    _updateForkedTypeChecker(rootNames, changedCompilationFiles) {
        if (this._typeCheckerProcess) {
            if (!this._forkedTypeCheckerInitialized) {
                let hostReplacementPaths = {};
                if (this._options.hostReplacementPaths
                    && typeof this._options.hostReplacementPaths != 'function') {
                    hostReplacementPaths = this._options.hostReplacementPaths;
                }
                this._typeCheckerProcess.send(new type_checker_messages_1.InitMessage(this._compilerOptions, this._basePath, this._JitMode, this._rootNames, hostReplacementPaths));
                this._forkedTypeCheckerInitialized = true;
            }
            this._typeCheckerProcess.send(new type_checker_messages_1.UpdateMessage(rootNames, changedCompilationFiles));
        }
    }
    _checkUnusedFiles(compilation) {
        // Only do the unused TS files checks when under Ivy
        // since previously we did include unused files in the compilation
        // See: https://github.com/angular/angular-cli/pull/15030
        // Don't do checks for compilations with errors, since that can result in a partial compilation.
        if (!this._compilerOptions.enableIvy || compilation.errors.length > 0) {
            return;
        }
        // Bail if there's no TS program. Nothing to do in that case.
        const program = this._getTsProgram();
        if (!program) {
            return;
        }
        // Exclude the following files from unused checks
        // - ngfactories & ngstyle might not have a correspondent
        //   JS file example `@angular/core/core.ngfactory.ts`.
        // - ngtypecheck.ts and __ng_typecheck__.ts are used for type-checking in Ivy.
        const fileExcludeRegExp = /(\.(ngfactory|ngstyle|ngsummary|ngtypecheck)\.ts|ng_typecheck__\.ts)$/;
        // Start all the source file names we care about.
        // Ignore matches to the regexp above, files we've already reported once before, and
        // node_modules.
        const sourceFiles = program.getSourceFiles()
            .map(x => this._compilerHost.denormalizePath(x.fileName))
            .filter(f => !(fileExcludeRegExp.test(f) || this._unusedFiles.has(f)
            || this._nodeModulesRegExp.test(f)));
        // Make a set with the sources, but exclude .d.ts files since those are type-only.
        const unusedSourceFileNames = new Set(sourceFiles.filter(f => !f.endsWith('.d.ts')));
        // Separately keep track of type-only deps.
        const typeDepFileNames = new Set(sourceFiles);
        // This function removes a source file name and all its dependencies from the set.
        const removeSourceFile = (fileName, originalModule = false) => {
            if (unusedSourceFileNames.has(fileName) || (originalModule && typeDepFileNames.has(fileName))) {
                unusedSourceFileNames.delete(fileName);
                if (originalModule) {
                    typeDepFileNames.delete(fileName);
                }
                this.getDependencies(fileName, false).forEach(f => removeSourceFile(f));
            }
        };
        // Go over all the modules in the webpack compilation and remove them from the sets.
        // tslint:disable-next-line: no-any
        compilation.modules.forEach((m) => m.resource ? removeSourceFile(m.resource, true) : null);
        // Anything that remains is unused, because it wasn't referenced directly or transitively
        // on the files in the compilation.
        for (const fileName of unusedSourceFileNames) {
            webpack_diagnostics_1.addWarning(compilation, `${fileName} is part of the TypeScript compilation but it's unused.\n` +
                `Add only entry points to the 'files' or 'include' properties in your tsconfig.`);
            this._unusedFiles.add(fileName);
            // Remove the truly unused from the type dep list.
            typeDepFileNames.delete(fileName);
        }
        // At this point we know what the type deps are.
        // These are the TS files that weren't part of the compilation modules, aren't unused, but were
        // part of the TS original source list.
        // Next build we add them to the TS entry points so that they trigger rebuilds.
        for (const fileName of typeDepFileNames) {
            this._typeDeps.add(fileName);
        }
    }
    // Registration hook for webpack plugin.
    // tslint:disable-next-line:no-big-function
    apply(webpackCompiler) {
        const compiler = webpackCompiler;
        // The below is require by NGCC processor
        // since we need to know which fields we need to process
        compiler.hooks.environment.tap('angular-compiler', () => {
            const { options } = compiler;
            const mainFields = options.resolve && options.resolve.mainFields;
            if (mainFields) {
                this._mainFields = utils_1.flattenArray(mainFields);
            }
        });
        // cleanup if not watching
        compiler.hooks.thisCompilation.tap('angular-compiler', compilation => {
            compilation.hooks.finishModules.tap('angular-compiler', () => {
                this._checkUnusedFiles(compilation);
                let rootCompiler = compiler;
                while (rootCompiler.parentCompilation) {
                    // tslint:disable-next-line:no-any
                    rootCompiler = compiler.parentCompilation;
                }
                // only present for webpack 4.23.0+, assume true otherwise
                const watchMode = rootCompiler.watchMode === undefined ? true : rootCompiler.watchMode;
                if (!watchMode) {
                    this._program = undefined;
                    this._transformers = [];
                    this._resourceLoader = undefined;
                    this._compilerHost.reset();
                }
            });
        });
        // Decorate inputFileSystem to serve contents of CompilerHost.
        // Use decorated inputFileSystem in watchFileSystem.
        compiler.hooks.environment.tap('angular-compiler', () => {
            var _a;
            let host = this._options.host || webpack_input_host_1.createWebpackInputHost(compiler.inputFileSystem);
            let replacements;
            if (this._options.hostReplacementPaths) {
                if (typeof this._options.hostReplacementPaths == 'function') {
                    const replacementResolver = this._options.hostReplacementPaths;
                    replacements = path => core_1.normalize(replacementResolver(core_1.getSystemPath(path)));
                    host = new class extends core_1.virtualFs.ResolverHost {
                        _resolve(path) {
                            return core_1.normalize(replacementResolver(core_1.getSystemPath(path)));
                        }
                    }(host);
                }
                else {
                    replacements = new Map();
                    const aliasHost = new core_1.virtualFs.AliasHost(host);
                    for (const from in this._options.hostReplacementPaths) {
                        const normalizedFrom = core_1.resolve(core_1.normalize(this._basePath), core_1.normalize(from));
                        const normalizedWith = core_1.resolve(core_1.normalize(this._basePath), core_1.normalize(this._options.hostReplacementPaths[from]));
                        aliasHost.aliases.set(normalizedFrom, normalizedWith);
                        replacements.set(normalizedFrom, normalizedWith);
                    }
                    host = aliasHost;
                }
            }
            let ngccProcessor;
            if (this._compilerOptions.enableIvy) {
                ngccProcessor = new ngcc_processor_1.NgccProcessor(this._mainFields, this._warnings, this._errors, this._basePath, this._tsConfigPath, compiler.inputFileSystem, (_a = compiler.options.resolve) === null || _a === void 0 ? void 0 : _a.symlinks);
                ngccProcessor.process();
            }
            // Use an identity function as all our paths are absolute already.
            this._moduleResolutionCache = ts.createModuleResolutionCache(this._basePath, x => x);
            // Create the webpack compiler host.
            const webpackCompilerHost = new compiler_host_1.WebpackCompilerHost(this._compilerOptions, this._basePath, host, true, this._options.directTemplateLoading, ngccProcessor, this._moduleResolutionCache);
            // Create and set a new WebpackResourceLoader in AOT
            if (!this._JitMode) {
                this._resourceLoader = new resource_loader_1.WebpackResourceLoader();
                webpackCompilerHost.setResourceLoader(this._resourceLoader);
            }
            // Use the WebpackCompilerHost with a resource loader to create an AngularCompilerHost.
            this._compilerHost = compiler_cli_1.createCompilerHost({
                options: this._compilerOptions,
                tsHost: webpackCompilerHost,
            });
            // Resolve mainPath if provided.
            if (this._options.mainPath) {
                this._mainPath = this._compilerHost.resolve(this._options.mainPath);
            }
            const inputDecorator = new virtual_file_system_decorator_1.VirtualFileSystemDecorator(compiler.inputFileSystem, this._compilerHost);
            compiler.inputFileSystem = inputDecorator;
            compiler.watchFileSystem = new virtual_file_system_decorator_1.VirtualWatchFileSystemDecorator(inputDecorator, replacements);
        });
        // Create and destroy forked type checker on watch mode.
        compiler.hooks.watchRun.tap('angular-compiler', () => {
            if (this._forkTypeChecker && !this._typeCheckerProcess) {
                this._createForkedTypeChecker();
            }
        });
        compiler.hooks.watchClose.tap('angular-compiler', () => this._killForkedTypeChecker());
        // Remake the plugin on each compilation.
        compiler.hooks.make.tapPromise('angular-compiler', compilation => this._donePromise = this._make(compilation));
        compiler.hooks.invalid.tap('angular-compiler', () => this._firstRun = false);
        compiler.hooks.afterEmit.tap('angular-compiler', compilation => {
            // tslint:disable-next-line:no-any
            compilation._ngToolsWebpackPluginInstance = null;
        });
        compiler.hooks.done.tap('angular-compiler', () => {
            this._donePromise = null;
        });
        compiler.hooks.afterResolvers.tap('angular-compiler', compiler => {
            if (this._compilerOptions.enableIvy) {
                // When Ivy is enabled we need to add the fields added by NGCC
                // to take precedence over the provided mainFields.
                // NGCC adds fields in package.json suffixed with '_ivy_ngcc'
                // Example: module -> module_ivy_ngcc
                // tslint:disable-next-line:no-any
                compiler.resolverFactory.hooks.resolveOptions
                    .for('normal')
                    // tslint:disable-next-line:no-any
                    .tap('WebpackOptionsApply', (resolveOptions) => {
                    const originalMainFields = resolveOptions.mainFields;
                    const ivyMainFields = originalMainFields.map(f => `${f}_ivy_ngcc`);
                    return webpack_version_1.mergeResolverMainFields(resolveOptions, originalMainFields, ivyMainFields);
                });
            }
            // tslint:disable-next-line: no-any
            compiler.resolverFactory.hooks.resolveOptions
                .for('normal')
                .tap('angular-compiler', (resolveOptions) => {
                if (!resolveOptions.plugins) {
                    resolveOptions.plugins = [];
                }
                resolveOptions.plugins.push(new paths_plugin_1.TypeScriptPathsPlugin(this._compilerOptions));
                return resolveOptions;
            });
            compiler.hooks.normalModuleFactory.tap('angular-compiler', nmf => {
                // Virtual file system.
                // TODO: consider if it's better to remove this plugin and instead make it wait on the
                // VirtualFileSystemDecorator.
                // Wait for the plugin to be done when requesting `.ts` files directly (entry points), or
                // when the issuer is a `.ts` or `.ngfactory.js` file.
                nmf.hooks.beforeResolve.tapPromise('angular-compiler', async (request) => {
                    if (this.done && request) {
                        const name = request.request;
                        const issuer = request.contextInfo.issuer;
                        if (name.endsWith('.ts') || name.endsWith('.tsx')
                            || (issuer && /\.ts|ngfactory\.js$/.test(issuer))) {
                            try {
                                await this.done;
                            }
                            catch (_a) { }
                        }
                    }
                    if (!webpack_version_1.isWebpackFiveOrHigher()) {
                        return request;
                    }
                });
            });
        });
    }
    async _make(compilation) {
        benchmark_1.time('AngularCompilerPlugin._make');
        // tslint:disable-next-line:no-any
        if (compilation._ngToolsWebpackPluginInstance) {
            throw new Error('An @ngtools/webpack plugin already exist for this compilation.');
        }
        // If there is no compiler host at this point, it means that the environment hook did not run.
        // This happens in child compilations that inherit the parent compilation file system.
        // Node: child compilations also do not run most webpack compiler hooks, including almost all
        // we use here. The child compiler will always run as if it was the first build.
        if (this._compilerHost === undefined) {
            const inputFs = compilation.compiler.inputFileSystem;
            if (!inputFs.getWebpackCompilerHost) {
                throw new Error('AngularCompilerPlugin is running in a child compilation, but could' +
                    'not find a WebpackCompilerHost in the parent compilation.');
            }
            // Use the existing WebpackCompilerHost to ensure builds and rebuilds work.
            this._compilerHost = compiler_cli_1.createCompilerHost({
                options: this._compilerOptions,
                tsHost: inputFs.getWebpackCompilerHost(),
            });
        }
        // Set a private variable for this plugin instance.
        // tslint:disable-next-line:no-any
        compilation._ngToolsWebpackPluginInstance = this;
        // Update the resource loader with the new webpack compilation.
        if (this._resourceLoader) {
            this._resourceLoader.update(compilation);
        }
        try {
            await this._update();
            this.pushCompilationErrors(compilation);
        }
        catch (err) {
            webpack_diagnostics_1.addError(compilation, err.message || err);
            this.pushCompilationErrors(compilation);
        }
        benchmark_1.timeEnd('AngularCompilerPlugin._make');
    }
    pushCompilationErrors(compilation) {
        this._errors.forEach((error) => webpack_diagnostics_1.addError(compilation, error));
        this._warnings.forEach((warning) => webpack_diagnostics_1.addWarning(compilation, warning));
        this._errors = [];
        this._warnings = [];
    }
    _makeTransformers() {
        const isAppPath = (fileName) => !fileName.endsWith('.ngfactory.ts') && !fileName.endsWith('.ngstyle.ts');
        const isMainPath = (fileName) => fileName === (this._mainPath ? utils_1.workaroundResolve(this._mainPath) : this._mainPath);
        const getEntryModule = () => this.entryModule
            ? { path: utils_1.workaroundResolve(this.entryModule.path), className: this.entryModule.className }
            : this.entryModule;
        const getTypeChecker = () => this._getTsProgram().getTypeChecker();
        if (this._JitMode) {
            // Replace resources in JIT.
            this._transformers.push(transformers_1.replaceResources(isAppPath, getTypeChecker, this._options.directTemplateLoading));
            // Downlevel constructor parameters for DI support
            // This is required to support forwardRef in ES2015 due to TDZ issues
            // This wrapper is needed here due to the program not being available until after the transformers are created.
            const downlevelFactory = (context) => {
                const factory = tooling_1.constructorParametersDownlevelTransform(this._getTsProgram());
                return factory(context);
            };
            this._transformers.push(downlevelFactory);
        }
        else {
            if (!this._compilerOptions.enableIvy) {
                // Remove unneeded angular decorators in VE.
                // In Ivy they are removed in ngc directly.
                this._transformers.push(transformers_1.removeDecorators(isAppPath, getTypeChecker));
            }
            else {
                // Default for both options is to emit (undefined means true)
                const removeClassMetadata = this._options.emitClassMetadata === false;
                const removeNgModuleScope = this._options.emitNgModuleScope === false;
                if (removeClassMetadata || removeNgModuleScope) {
                    this._transformers.push(remove_ivy_jit_support_calls_1.removeIvyJitSupportCalls(removeClassMetadata, removeNgModuleScope, getTypeChecker));
                }
            }
            // Import ngfactory in loadChildren import syntax
            if (this._useFactories) {
                // Only transform imports to use factories with View Engine.
                this._transformers.push(transformers_1.importFactory(msg => this._warnings.push(msg), getTypeChecker));
            }
        }
        if (this._platformTransformers !== null) {
            this._transformers.push(...this._platformTransformers);
        }
        else {
            if (this._platform === interfaces_1.PLATFORM.Browser) {
                // If we have a locale, auto import the locale data file.
                // This transform must go before replaceBootstrap because it looks for the entry module
                // import, which will be replaced.
                if (this._normalizedLocale) {
                    this._transformers.push(transformers_1.registerLocaleData(isAppPath, getEntryModule, this._normalizedLocale));
                }
                if (!this._JitMode) {
                    // Replace bootstrap in browser non JIT Mode.
                    this._transformers.push(transformers_1.replaceBootstrap(isAppPath, getEntryModule, getTypeChecker, this._useFactories));
                }
            }
            else if (this._platform === interfaces_1.PLATFORM.Server && this._useFactories) {
                this._transformers.push(transformers_1.exportNgFactory(isMainPath, getEntryModule), transformers_1.replaceServerBootstrap(isMainPath, getEntryModule, getTypeChecker));
            }
        }
    }
    async _update() {
        benchmark_1.time('AngularCompilerPlugin._update');
        // We only want to update on TS and template changes, but all kinds of files are on this
        // list, like package.json and .ngsummary.json files.
        const changedFiles = this._getChangedCompilationFiles();
        // If nothing we care about changed and it isn't the first run, don't do anything.
        if (changedFiles.length === 0 && !this._firstRun) {
            return;
        }
        // Make a new program and load the Angular structure.
        await this._createOrUpdateProgram();
        // Emit files.
        benchmark_1.time('AngularCompilerPlugin._update._emit');
        const { emitResult, diagnostics } = this._emit();
        benchmark_1.timeEnd('AngularCompilerPlugin._update._emit');
        // Report any diagnostics.
        diagnostics_1.reportDiagnostics(diagnostics, msg => this._errors.push(msg), msg => this._warnings.push(msg));
        this._emitSkipped = !emitResult || emitResult.emitSkipped;
        // Reset changed files on successful compilation.
        if (!this._emitSkipped && this._errors.length === 0) {
            this._compilerHost.resetChangedFileTracker();
        }
        benchmark_1.timeEnd('AngularCompilerPlugin._update');
    }
    writeI18nOutFile() {
        function _recursiveMkDir(p) {
            if (!fs.existsSync(p)) {
                _recursiveMkDir(path.dirname(p));
                fs.mkdirSync(p);
            }
        }
        // Write the extracted messages to disk.
        if (this._compilerOptions.i18nOutFile) {
            const i18nOutFilePath = path.resolve(this._basePath, this._compilerOptions.i18nOutFile);
            const i18nOutFileContent = this._compilerHost.readFile(i18nOutFilePath);
            if (i18nOutFileContent) {
                _recursiveMkDir(path.dirname(i18nOutFilePath));
                fs.writeFileSync(i18nOutFilePath, i18nOutFileContent);
            }
        }
    }
    getCompiledFile(fileName) {
        const outputFile = fileName.replace(/.tsx?$/, '.js');
        let outputText;
        let sourceMap;
        let errorDependencies = [];
        if (this._emitSkipped) {
            const text = this._compilerHost.readFile(outputFile);
            if (text) {
                // If the compilation didn't emit files this time, try to return the cached files from the
                // last compilation and let the compilation errors show what's wrong.
                outputText = text;
                sourceMap = this._compilerHost.readFile(outputFile + '.map');
            }
            else {
                // There's nothing we can serve. Return an empty string to prevent lenghty webpack errors,
                // add the rebuild warning if it's not there yet.
                // We also need to all changed files as dependencies of this file, so that all of them
                // will be watched and trigger a rebuild next time.
                outputText = '';
                const program = this._getTsProgram();
                errorDependencies = (program ? program.getSourceFiles().map(x => x.fileName) : [])
                    // These paths are used by the loader so we must denormalize them.
                    .map((p) => this._compilerHost.denormalizePath(p));
            }
        }
        else {
            // Check if the TS input file and the JS output file exist.
            if (((fileName.endsWith('.ts') || fileName.endsWith('.tsx'))
                && !this._compilerHost.fileExists(fileName))
                || !this._compilerHost.fileExists(outputFile, false)) {
                let msg = `${fileName} is missing from the TypeScript compilation. `
                    + `Please make sure it is in your tsconfig via the 'files' or 'include' property.`;
                if (this._nodeModulesRegExp.test(fileName)) {
                    msg += '\nThe missing file seems to be part of a third party library. '
                        + 'TS files in published libraries are often a sign of a badly packaged library. '
                        + 'Please open an issue in the library repository to alert its author and ask them '
                        + 'to package the library using the Angular Package Format (https://goo.gl/jB3GVv).';
                }
                throw new Error(msg);
            }
            outputText = this._compilerHost.readFile(outputFile) || '';
            sourceMap = this._compilerHost.readFile(outputFile + '.map');
        }
        return { outputText, sourceMap, errorDependencies };
    }
    getDependencies(fileName, includeResources = true) {
        const resolvedFileName = this._compilerHost.resolve(fileName);
        const sourceFile = this._compilerHost.getSourceFile(resolvedFileName, ts.ScriptTarget.Latest);
        if (!sourceFile) {
            return [];
        }
        const options = this._compilerOptions;
        const host = this._compilerHost;
        const cache = this._moduleResolutionCache;
        const esImports = ast_helpers_1.collectDeepNodes(sourceFile, [
            ts.SyntaxKind.ImportDeclaration,
            ts.SyntaxKind.ExportDeclaration,
        ])
            .map(decl => {
            if (!decl.moduleSpecifier) {
                return null;
            }
            const moduleName = decl.moduleSpecifier.text;
            const resolved = ts.resolveModuleName(moduleName, resolvedFileName, options, host, cache);
            if (resolved.resolvedModule) {
                return resolved.resolvedModule.resolvedFileName;
            }
            else {
                return null;
            }
        })
            .filter(x => x);
        let resourceImports = [];
        const resourceDependencies = [];
        if (includeResources) {
            resourceImports = transformers_1.findResources(sourceFile)
                .map(resourcePath => core_1.resolve(core_1.dirname(resolvedFileName), core_1.normalize(resourcePath)));
            for (const resource of resourceImports) {
                for (const dep of this.getResourceDependencies(this._compilerHost.denormalizePath(resource))) {
                    resourceDependencies.push(dep);
                }
            }
        }
        // These paths are meant to be used by the loader so we must denormalize them.
        const uniqueDependencies = new Set([
            ...esImports,
            ...resourceImports,
            ...resourceDependencies,
        ].map((p) => p && this._compilerHost.denormalizePath(p)));
        return [...uniqueDependencies];
    }
    getResourceDependencies(fileName) {
        if (!this._resourceLoader) {
            return [];
        }
        // The source loader uses TS-style forward slash paths for all platforms.
        const resolvedFileName = utils_1.forwardSlashPath(fileName);
        return this._resourceLoader.getResourceDependencies(resolvedFileName);
    }
    getTypeDependencies(fileName) {
        // We currently add all type deps directly to the main path.
        // If there's no main path or the lookup isn't the main path, bail.
        if (!this._mainPath || this._compilerHost.resolve(fileName) != this._mainPath) {
            return [];
        }
        // Note: this set is always for the previous build, not the current build.
        // It should be better than not having rebuilds on type deps but isn't 100% correct.
        return Array.from(this._typeDeps);
    }
    // This code mostly comes from `performCompilation` in `@angular/compiler-cli`.
    // It skips the program creation because we need to use `loadNgStructureAsync()`,
    // and uses CustomTransformers.
    _emit() {
        benchmark_1.time('AngularCompilerPlugin._emit');
        const program = this._program;
        const allDiagnostics = [];
        const diagMode = (this._firstRun || !this._forkTypeChecker) ?
            diagnostics_1.DiagnosticMode.All : diagnostics_1.DiagnosticMode.Syntactic;
        let emitResult;
        try {
            if (this._JitMode) {
                const tsProgram = program;
                const changedTsFiles = new Set();
                if (this._firstRun) {
                    // Check parameter diagnostics.
                    benchmark_1.time('AngularCompilerPlugin._emit.ts.getOptionsDiagnostics');
                    allDiagnostics.push(...tsProgram.getOptionsDiagnostics());
                    benchmark_1.timeEnd('AngularCompilerPlugin._emit.ts.getOptionsDiagnostics');
                }
                else {
                    // generate a list of changed files for emit
                    // not needed on first run since a full program emit is required
                    for (const changedFile of this._compilerHost.getChangedFilePaths()) {
                        if (!/.(tsx|ts|json|js)$/.test(changedFile)) {
                            continue;
                        }
                        // existing type definitions are not emitted
                        if (changedFile.endsWith('.d.ts')) {
                            continue;
                        }
                        changedTsFiles.add(changedFile);
                    }
                }
                allDiagnostics.push(...diagnostics_1.gatherDiagnostics(tsProgram, this._JitMode, 'AngularCompilerPlugin._emit.ts', diagMode));
                if (!diagnostics_1.hasErrors(allDiagnostics)) {
                    if (this._firstRun || changedTsFiles.size > 20 || !this._hadFullJitEmit) {
                        emitResult = tsProgram.emit(undefined, undefined, undefined, undefined, { before: this._transformers });
                        this._hadFullJitEmit = !emitResult.emitSkipped;
                        allDiagnostics.push(...emitResult.diagnostics);
                    }
                    else {
                        for (const changedFile of changedTsFiles) {
                            const sourceFile = tsProgram.getSourceFile(changedFile);
                            if (!sourceFile) {
                                continue;
                            }
                            const timeLabel = `AngularCompilerPlugin._emit.ts+${sourceFile.fileName}+.emit`;
                            benchmark_1.time(timeLabel);
                            emitResult = tsProgram.emit(sourceFile, undefined, undefined, undefined, { before: this._transformers });
                            allDiagnostics.push(...emitResult.diagnostics);
                            benchmark_1.timeEnd(timeLabel);
                        }
                    }
                }
            }
            else {
                const angularProgram = program;
                // Check Angular structural diagnostics.
                benchmark_1.time('AngularCompilerPlugin._emit.ng.getNgStructuralDiagnostics');
                allDiagnostics.push(...angularProgram.getNgStructuralDiagnostics());
                benchmark_1.timeEnd('AngularCompilerPlugin._emit.ng.getNgStructuralDiagnostics');
                if (this._firstRun) {
                    // Check TypeScript parameter diagnostics.
                    benchmark_1.time('AngularCompilerPlugin._emit.ng.getTsOptionDiagnostics');
                    allDiagnostics.push(...angularProgram.getTsOptionDiagnostics());
                    benchmark_1.timeEnd('AngularCompilerPlugin._emit.ng.getTsOptionDiagnostics');
                    // Check Angular parameter diagnostics.
                    benchmark_1.time('AngularCompilerPlugin._emit.ng.getNgOptionDiagnostics');
                    allDiagnostics.push(...angularProgram.getNgOptionDiagnostics());
                    benchmark_1.timeEnd('AngularCompilerPlugin._emit.ng.getNgOptionDiagnostics');
                }
                allDiagnostics.push(...diagnostics_1.gatherDiagnostics(angularProgram, this._JitMode, 'AngularCompilerPlugin._emit.ng', diagMode));
                if (!diagnostics_1.hasErrors(allDiagnostics)) {
                    benchmark_1.time('AngularCompilerPlugin._emit.ng.emit');
                    const extractI18n = !!this._compilerOptions.i18nOutFile;
                    const emitFlags = extractI18n ? compiler_cli_1.EmitFlags.I18nBundle : compiler_cli_1.EmitFlags.Default;
                    emitResult = angularProgram.emit({
                        emitFlags, customTransformers: {
                            beforeTs: this._transformers,
                        },
                    });
                    allDiagnostics.push(...emitResult.diagnostics);
                    if (extractI18n) {
                        this.writeI18nOutFile();
                    }
                    benchmark_1.timeEnd('AngularCompilerPlugin._emit.ng.emit');
                }
            }
        }
        catch (e) {
            benchmark_1.time('AngularCompilerPlugin._emit.catch');
            // This function is available in the import below, but this way we avoid the dependency.
            // import { isSyntaxError } from '@angular/compiler';
            function isSyntaxError(error) {
                return error['ngSyntaxError']; // tslint:disable-line:no-any
            }
            let errMsg;
            let code;
            if (isSyntaxError(e)) {
                // don't report the stack for syntax errors as they are well known errors.
                errMsg = e.message;
                code = compiler_cli_1.DEFAULT_ERROR_CODE;
            }
            else {
                errMsg = e.stack;
                // It is not a syntax error we might have a program with unknown state, discard it.
                this._program = undefined;
                code = compiler_cli_1.UNKNOWN_ERROR_CODE;
            }
            allDiagnostics.push({ category: ts.DiagnosticCategory.Error, messageText: errMsg, code, source: compiler_cli_1.SOURCE });
            benchmark_1.timeEnd('AngularCompilerPlugin._emit.catch');
        }
        benchmark_1.timeEnd('AngularCompilerPlugin._emit');
        return { program, emitResult, diagnostics: allDiagnostics };
    }
    _validateLocale(locale) {
        // Get the path of the common module.
        const commonPath = path.dirname(require.resolve('@angular/common/package.json'));
        // Check if the locale file exists
        if (!fs.existsSync(path.resolve(commonPath, 'locales', `${locale}.js`))) {
            // Check for an alternative locale (if the locale id was badly formatted).
            const locales = fs.readdirSync(path.resolve(commonPath, 'locales'))
                .filter(file => file.endsWith('.js'))
                .map(file => file.replace('.js', ''));
            let newLocale;
            const normalizedLocale = locale.toLowerCase().replace(/_/g, '-');
            for (const l of locales) {
                if (l.toLowerCase() === normalizedLocale) {
                    newLocale = l;
                    break;
                }
            }
            if (newLocale) {
                locale = newLocale;
            }
            else {
                // Check for a parent locale
                const parentLocale = normalizedLocale.split('-')[0];
                if (locales.indexOf(parentLocale) !== -1) {
                    locale = parentLocale;
                }
                else {
                    this._warnings.push(`AngularCompilerPlugin: Unable to load the locale data file ` +
                        `"@angular/common/locales/${locale}", ` +
                        `please check that "${locale}" is a valid locale id.
            If needed, you can use "registerLocaleData" manually.`);
                    return null;
                }
            }
        }
        return locale;
    }
}
exports.AngularCompilerPlugin = AngularCompilerPlugin;

/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {ConstantPool} from '@angular/compiler';
import * as ts from 'typescript';

import {ComponentDecoratorHandler, DirectiveDecoratorHandler, InjectableDecoratorHandler, NgModuleDecoratorHandler, PipeDecoratorHandler, ReferencesRegistry, ResourceLoader} from '../../../src/ngtsc/annotations';
import {CycleAnalyzer, ImportGraph} from '../../../src/ngtsc/cycles';
import {isFatalDiagnosticError} from '../../../src/ngtsc/diagnostics';
import {FileSystem, LogicalFileSystem, absoluteFrom, dirname, resolve} from '../../../src/ngtsc/file_system';
import {AbsoluteModuleStrategy, LocalIdentifierStrategy, LogicalProjectStrategy, ModuleResolver, NOOP_DEFAULT_IMPORT_RECORDER, PrivateExportAliasingHost, Reexport, ReferenceEmitter} from '../../../src/ngtsc/imports';
import {CompoundMetadataReader, CompoundMetadataRegistry, DtsMetadataReader, InjectableClassRegistry, LocalMetadataRegistry} from '../../../src/ngtsc/metadata';
import {PartialEvaluator} from '../../../src/ngtsc/partial_evaluator';
import {ClassDeclaration} from '../../../src/ngtsc/reflection';
import {LocalModuleScopeRegistry, MetadataDtsModuleScopeResolver} from '../../../src/ngtsc/scope';
import {CompileResult, DecoratorHandler, TraitState, resolveTrait} from '../../../src/ngtsc/transform';
import {NgccClassSymbol, NgccReflectionHost} from '../host/ngcc_host';
import {Migration} from '../migrations/migration';
import {MissingInjectableMigration} from '../migrations/missing_injectable_migration';
import {UndecoratedChildMigration} from '../migrations/undecorated_child_migration';
import {UndecoratedParentMigration} from '../migrations/undecorated_parent_migration';
import {EntryPointBundle} from '../packages/entry_point_bundle';
import {isDefined} from '../utils';

import {DefaultMigrationHost} from './migration_host';
import {AnalyzedClass, AnalyzedFile, CompiledClass, CompiledFile, DecorationAnalyses} from './types';
import {NOOP_DEPENDENCY_TRACKER, analyzeDecorators, isWithinPackage} from './util';



/**
 * Simple class that resolves and loads files directly from the filesystem.
 */
class NgccResourceLoader implements ResourceLoader {
  constructor(private fs: FileSystem) {}
  canPreload = false;
  preload(): undefined|Promise<void> { throw new Error('Not implemented.'); }
  load(url: string): string { return this.fs.readFile(resolve(url)); }
  resolve(url: string, containingFile: string): string {
    return resolve(dirname(absoluteFrom(containingFile)), url);
  }
}

/**
 * This Analyzer will analyze the files that have decorated classes that need to be transformed.
 */
export class DecorationAnalyzer {
  private program = this.bundle.src.program;
  private options = this.bundle.src.options;
  private host = this.bundle.src.host;
  private typeChecker = this.bundle.src.program.getTypeChecker();
  private rootDirs = this.bundle.rootDirs;
  private packagePath = this.bundle.entryPoint.package;
  private isCore = this.bundle.isCore;

  /**
   * Map of NgModule declarations to the re-exports for that NgModule.
   */
  private reexportMap = new Map<ts.Declaration, Map<string, [string, string]>>();
  moduleResolver =
      new ModuleResolver(this.program, this.options, this.host, /* moduleResolutionCache */ null);
  resourceManager = new NgccResourceLoader(this.fs);
  metaRegistry = new LocalMetadataRegistry();
  dtsMetaReader = new DtsMetadataReader(this.typeChecker, this.reflectionHost);
  fullMetaReader = new CompoundMetadataReader([this.metaRegistry, this.dtsMetaReader]);
  refEmitter = new ReferenceEmitter([
    new LocalIdentifierStrategy(),
    new AbsoluteModuleStrategy(
        this.program, this.typeChecker, this.moduleResolver, this.reflectionHost),
    // TODO(alxhub): there's no reason why ngcc needs the "logical file system" logic here, as ngcc
    // projects only ever have one rootDir. Instead, ngcc should just switch its emitted import
    // based on whether a bestGuessOwningModule is present in the Reference.
    new LogicalProjectStrategy(this.reflectionHost, new LogicalFileSystem(this.rootDirs)),
  ]);
  aliasingHost = this.bundle.entryPoint.generateDeepReexports?
                 new PrivateExportAliasingHost(this.reflectionHost): null;
  dtsModuleScopeResolver =
      new MetadataDtsModuleScopeResolver(this.dtsMetaReader, this.aliasingHost);
  scopeRegistry = new LocalModuleScopeRegistry(
      this.metaRegistry, this.dtsModuleScopeResolver, this.refEmitter, this.aliasingHost);
  fullRegistry = new CompoundMetadataRegistry([this.metaRegistry, this.scopeRegistry]);
  evaluator =
      new PartialEvaluator(this.reflectionHost, this.typeChecker, /* dependencyTracker */ null);
  importGraph = new ImportGraph(this.moduleResolver);
  cycleAnalyzer = new CycleAnalyzer(this.importGraph);
  injectableRegistry = new InjectableClassRegistry(this.reflectionHost);
  handlers: DecoratorHandler<unknown, unknown, unknown>[] = [
    new ComponentDecoratorHandler(
        this.reflectionHost, this.evaluator, this.fullRegistry, this.fullMetaReader,
        this.scopeRegistry, this.scopeRegistry, this.isCore, this.resourceManager, this.rootDirs,
        /* defaultPreserveWhitespaces */ false,
        /* i18nUseExternalIds */ true, this.bundle.enableI18nLegacyMessageIdFormat,
        this.moduleResolver, this.cycleAnalyzer, this.refEmitter, NOOP_DEFAULT_IMPORT_RECORDER,
        NOOP_DEPENDENCY_TRACKER, this.injectableRegistry, /* annotateForClosureCompiler */ false),
    // See the note in ngtsc about why this cast is needed.
    // clang-format off
    new DirectiveDecoratorHandler(
        this.reflectionHost, this.evaluator, this.fullRegistry, this.scopeRegistry,
        this.fullMetaReader, NOOP_DEFAULT_IMPORT_RECORDER, this.injectableRegistry, this.isCore,
        /* annotateForClosureCompiler */ false) as DecoratorHandler<unknown, unknown, unknown>,
    // clang-format on
    // Pipe handler must be before injectable handler in list so pipe factories are printed
    // before injectable factories (so injectable factories can delegate to them)
    new PipeDecoratorHandler(
        this.reflectionHost, this.evaluator, this.metaRegistry, this.scopeRegistry,
        NOOP_DEFAULT_IMPORT_RECORDER, this.injectableRegistry, this.isCore),
    new InjectableDecoratorHandler(
        this.reflectionHost, NOOP_DEFAULT_IMPORT_RECORDER, this.isCore,
        /* strictCtorDeps */ false, this.injectableRegistry, /* errorOnDuplicateProv */ false),
    new NgModuleDecoratorHandler(
        this.reflectionHost, this.evaluator, this.fullMetaReader, this.fullRegistry,
        this.scopeRegistry, this.referencesRegistry, this.isCore, /* routeAnalyzer */ null,
        this.refEmitter,
        /* factoryTracker */ null, NOOP_DEFAULT_IMPORT_RECORDER,
        /* annotateForClosureCompiler */ false, this.injectableRegistry),
  ];
  migrations: Migration[] = [
    new UndecoratedParentMigration(),
    new UndecoratedChildMigration(),
    new MissingInjectableMigration(),
  ];

  constructor(
      private fs: FileSystem, private bundle: EntryPointBundle,
      private reflectionHost: NgccReflectionHost, private referencesRegistry: ReferencesRegistry,
      private diagnosticHandler: (error: ts.Diagnostic) => void = () => {}) {}

  /**
   * Analyze a program to find all the decorated files should be transformed.
   *
   * @returns a map of the source files to the analysis for those files.
   */
  analyzeProgram(): DecorationAnalyses {
    const decorationAnalyses = new DecorationAnalyses();
    const analyzedFiles = this.program.getSourceFiles()
                              .filter(sourceFile => !sourceFile.isDeclarationFile)
                              .filter(sourceFile => isWithinPackage(this.packagePath, sourceFile))
                              .map(sourceFile => this.analyzeFile(sourceFile))
                              .filter(isDefined);

    this.applyMigrations(analyzedFiles);

    analyzedFiles.forEach(analyzedFile => this.resolveFile(analyzedFile));

    this.reportDiagnostics(analyzedFiles);

    const compiledFiles = analyzedFiles.map(analyzedFile => this.compileFile(analyzedFile));
    compiledFiles.forEach(
        compiledFile => decorationAnalyses.set(compiledFile.sourceFile, compiledFile));
    return decorationAnalyses;
  }

  protected analyzeFile(sourceFile: ts.SourceFile): AnalyzedFile|undefined {
    const analyzedClasses = this.reflectionHost.findClassSymbols(sourceFile)
                                .map(symbol => this.analyzeClass(symbol))
                                .filter(isDefined);
    return analyzedClasses.length ? {sourceFile, analyzedClasses} : undefined;
  }

  protected analyzeClass(symbol: NgccClassSymbol): AnalyzedClass|null {
    const decorators = this.reflectionHost.getDecoratorsOfSymbol(symbol);
    return analyzeDecorators(symbol, decorators, this.handlers);
  }

  protected applyMigrations(analyzedFiles: AnalyzedFile[]): void {
    const migrationHost = new DefaultMigrationHost(
        this.reflectionHost, this.fullMetaReader, this.evaluator, this.handlers,
        this.bundle.entryPoint.path, analyzedFiles);

    this.migrations.forEach(migration => {
      analyzedFiles.forEach(analyzedFile => {
        analyzedFile.analyzedClasses.forEach(analyzedClass => {
          const reportDiagnostic = (diagnostic: ts.Diagnostic) => {
            if (analyzedClass.metaDiagnostics === undefined) {
              analyzedClass.metaDiagnostics = [];
            }
            analyzedClass.metaDiagnostics.push(diagnostic);
          };

          try {
            const result = migration.apply(analyzedClass.declaration, migrationHost);
            if (result !== null) {
              reportDiagnostic(result);
            }
          } catch (e) {
            if (isFatalDiagnosticError(e)) {
              reportDiagnostic(e.toDiagnostic());
            } else {
              throw e;
            }
          }
        });
      });
    });
  }

  protected reportDiagnostics(analyzedFiles: AnalyzedFile[]) {
    for (const analyzedFile of analyzedFiles) {
      for (const analyzedClass of analyzedFile.analyzedClasses) {
        if (analyzedClass.metaDiagnostics !== undefined) {
          analyzedClass.metaDiagnostics.forEach(this.diagnosticHandler);
        }
        for (const trait of analyzedClass.traits) {
          if (trait.state === TraitState.ERRORED) {
            trait.diagnostics.forEach(this.diagnosticHandler);
          }
        }
      }
    }
  }

  protected compileFile(analyzedFile: AnalyzedFile): CompiledFile {
    const constantPool = new ConstantPool();
    const compiledClasses: CompiledClass[] = analyzedFile.analyzedClasses.map(analyzedClass => {
      const compilation = this.compileClass(analyzedClass, constantPool);
      const declaration = analyzedClass.declaration;
      const reexports: Reexport[] = this.getReexportsForClass(declaration);
      return {...analyzedClass, compilation, reexports};
    });
    return {constantPool, sourceFile: analyzedFile.sourceFile, compiledClasses};
  }

  protected compileClass(clazz: AnalyzedClass, constantPool: ConstantPool): CompileResult[] {
    const compilations: CompileResult[] = [];
    for (const trait of clazz.traits) {
      if (trait.state !== TraitState.RESOLVED) {
        continue;
      }
      const result =
          trait.handler.compile(clazz.declaration, trait.analysis, trait.resolution, constantPool);
      if (Array.isArray(result)) {
        result.forEach(current => {
          if (!compilations.some(compilation => compilation.name === current.name)) {
            compilations.push(current);
          }
        });
      } else if (!compilations.some(compilation => compilation.name === result.name)) {
        compilations.push(result);
      }
    }
    return compilations;
  }

  protected resolveFile(analyzedFile: AnalyzedFile): void {
    for (const {declaration, traits} of analyzedFile.analyzedClasses) {
      for (const trait of traits) {
        const result = resolveTrait(declaration, trait);
        if (result === null) {
          continue;
        }

        if (result.reexports !== undefined) {
          this.addReexports(result.reexports, declaration);
        }
      }
    }
  }

  private getReexportsForClass(declaration: ClassDeclaration<ts.Declaration>) {
    const reexports: Reexport[] = [];
    if (this.reexportMap.has(declaration)) {
      this.reexportMap.get(declaration) !.forEach(([fromModule, symbolName], asAlias) => {
        reexports.push({asAlias, fromModule, symbolName});
      });
    }
    return reexports;
  }

  private addReexports(reexports: Reexport[], declaration: ClassDeclaration<ts.Declaration>) {
    const map = new Map<string, [string, string]>();
    for (const reexport of reexports) {
      map.set(reexport.asAlias, [reexport.fromModule, reexport.symbolName]);
    }
    this.reexportMap.set(declaration, map);
  }
}

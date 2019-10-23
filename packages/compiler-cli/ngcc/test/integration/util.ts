/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as ts from 'typescript';

import {FileSystem, getFileSystem} from '../../../src/ngtsc/file_system';
import {MockFileSystemPosix} from '../../../src/ngtsc/file_system/testing';

import {loadStandardTestFiles} from '../../../test/helpers';

export type NodeModulesDef = {
  [name: string]: Package
};

export type Package = {
  [relPath: string]: string;
};

export function genNodeModules(def: NodeModulesDef): void {
  const fs = getFileSystem();
  for (const pkgName of Object.keys(def)) {
    compileNodeModuleToFs(fs, pkgName, def[pkgName]);
  }
}

function compileNodeModuleToFs(fs: FileSystem, pkgName: string, pkg: Package): void {
  const compileFs = new MockFileSystemPosix(true);
  compileFs.init(loadStandardTestFiles({fakeCore: false}));

  const options: ts.CompilerOptions = {
    declaration: true,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES5,
    lib: [],
  };

  const rootNames = Object.keys(pkg);

  for (const fileName of rootNames) {
    compileFs.writeFile(compileFs.resolve(fileName), pkg[fileName]);
  }

  const host = new MockCompilerHost(compileFs);
  const program = ts.createProgram({host, rootNames, options});
  program.emit();

  // Copy over the JS and .d.ts files, and add a .metadata.json for each .d.ts file.
  for (const inFileTs of rootNames) {
    const inFileBase = inFileTs.replace(/\.ts$/, '');
    fs.writeFile(
        fs.resolve(`/node_modules/${pkgName}/${inFileBase}.d.ts`),
        compileFs.readFile(compileFs.resolve(`${inFileBase}.d.ts`)));
    const jsContents = compileFs.readFile(compileFs.resolve(`${inFileBase}.js`));
    fs.writeFile(fs.resolve(`/node_modules/${pkgName}/${inFileBase}.js`), jsContents);
    fs.writeFile(fs.resolve(`/node_modules/${pkgName}/${inFileBase}.metadata.json`), '{}');
  }

  // Write the package.json
  const pkgJson: unknown = {
    name: pkgName,
    version: '0.0.1',
    main: './index.js',
    typings: './index.d.ts',
  };

  fs.writeFile(
      fs.resolve(`/node_modules/${pkgName}/package.json`), JSON.stringify(pkgJson, null, 2));
}

/**
 * A simple `ts.CompilerHost` that uses a `FileSystem` instead of the real FS.
 *
 * TODO(alxhub): convert this into a first class `FileSystemCompilerHost` and use it as the base for
 * the entire compiler.
 */
class MockCompilerHost implements ts.CompilerHost {
  constructor(private fs: FileSystem) {}
  getSourceFile(
      fileName: string, languageVersion: ts.ScriptTarget,
      onError?: ((message: string) => void)|undefined,
      shouldCreateNewSourceFile?: boolean|undefined): ts.SourceFile|undefined {
    return ts.createSourceFile(
        fileName, this.fs.readFile(this.fs.resolve(fileName)), languageVersion, true,
        ts.ScriptKind.TS);
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string {
    return ts.getDefaultLibFileName(options);
  }

  writeFile(fileName: string, data: string): void {
    this.fs.writeFile(this.fs.resolve(fileName), data);
  }

  getCurrentDirectory(): string { return this.fs.pwd(); }
  getCanonicalFileName(fileName: string): string { return fileName; }
  useCaseSensitiveFileNames(): boolean { return true; }
  getNewLine(): string { return '\n'; }
  fileExists(fileName: string): boolean { return this.fs.exists(this.fs.resolve(fileName)); }
  readFile(fileName: string): string|undefined {
    const abs = this.fs.resolve(fileName);
    return this.fs.exists(abs) ? this.fs.readFile(abs) : undefined;
  }
}
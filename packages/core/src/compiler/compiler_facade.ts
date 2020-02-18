/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {global} from '../util/global';
import {CompilerFacade, CompilerFacadeOptions, ExportedCompilerFacade} from './compiler_facade_interface';
export * from './compiler_facade_interface';

export function getCompilerFacade(): CompilerFacade {
  const globalNg: ExportedCompilerFacade = global['ng'];
  if (!globalNg || !globalNg.ɵcompilerFacade) {
    throw new Error(
        `Angular JIT compilation failed: '@angular/compiler' not loaded!\n` +
        `  - JIT compilation is discouraged for production use-cases! Consider AOT mode instead.\n` +
        `  - Did you bootstrap using '@angular/platform-browser-dynamic' or '@angular/platform-server'?\n` +
        `  - Alternatively provide the compiler with 'import "@angular/compiler";' before bootstrapping.`);
  }
  return globalNg.ɵcompilerFacade;
}

export function setCompilerOptions(options: CompilerFacadeOptions): void {
  const globalNg: ExportedCompilerFacade = global['ng'] || (global['ng'] = {});
  if (globalNg.ɵcompilerOptions !== undefined) {
    if (options.defaultEncapsulation !== globalNg.ɵcompilerOptions.defaultEncapsulation) {
      throw new Error(
          'Provided value for `defaultEncapsulation` can not be changed once it has been set.');
    }
    if (options.preserveWhitespaces !== globalNg.ɵcompilerOptions.preserveWhitespaces) {
      throw new Error(
          'Provided value for `preserveWhitespaces` can not be changed once it has been set.');
    }
  }
  globalNg.ɵcompilerOptions = options;
}

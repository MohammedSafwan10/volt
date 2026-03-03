/**
 * HTML/CSS LSP Service
 * 
 * Monaco Editor has built-in HTML and CSS support through its web workers.
 * This module provides additional configuration and programmatic access
 * to HTML/CSS language features.
 */

import type * as Monaco from 'monaco-editor';
import { getMonaco } from '$core/services/monaco-loader';

/**
 * Configure HTML language defaults
 */
export function configureHtmlDefaults(monaco: typeof Monaco): void {
  // Access HTML defaults through dynamic property access
  const languages = monaco.languages as Record<string, unknown>;
  const html = languages['html'] as {
    htmlDefaults?: {
      setOptions: (options: Record<string, unknown>) => void;
    };
  };

  if (!html?.htmlDefaults) {
    return;
  }

  html.htmlDefaults.setOptions({
    format: {
      tabSize: 2,
      insertSpaces: true,
      wrapLineLength: 120,
      unformatted: 'wbr',
      contentUnformatted: 'pre,code,textarea',
      indentInnerHtml: false,
      preserveNewLines: true,
      maxPreserveNewLines: 2,
      indentHandlebars: false,
      endWithNewline: false,
      extraLiners: 'head, body, /html',
      wrapAttributes: 'auto'
    },
    suggest: {
      html5: true
    },
    validate: {
      scripts: true,
      styles: true
    }
  });
}

/**
 * Configure CSS language defaults
 */
export function configureCssDefaults(monaco: typeof Monaco): void {
  // Access CSS defaults through dynamic property access
  const languages = monaco.languages as Record<string, unknown>;
  const css = languages['css'] as {
    cssDefaults?: {
      setOptions: (options: Record<string, unknown>) => void;
    };
    scssDefaults?: {
      setOptions: (options: Record<string, unknown>) => void;
    };
    lessDefaults?: {
      setOptions: (options: Record<string, unknown>) => void;
    };
  };

  const cssOptions = {
    validate: true,
    lint: {
      compatibleVendorPrefixes: 'warning',
      vendorPrefix: 'warning',
      duplicateProperties: 'warning',
      emptyRules: 'warning',
      importStatement: 'ignore',
      boxModel: 'ignore',
      universalSelector: 'warning',
      zeroUnits: 'ignore',
      fontFaceProperties: 'warning',
      hexColorLength: 'error',
      argumentsInColorFunction: 'error',
      unknownProperties: 'warning',
      unknownVendorSpecificProperties: 'warning',
      propertyIgnoredDueToDisplay: 'warning',
      important: 'ignore',
      float: 'ignore',
      idSelector: 'ignore'
    }
  };

  if (css?.cssDefaults) {
    css.cssDefaults.setOptions(cssOptions);
  }

  if (css?.scssDefaults) {
    css.scssDefaults.setOptions(cssOptions);
  }

  if (css?.lessDefaults) {
    css.lessDefaults.setOptions(cssOptions);
  }
}

/**
 * Check if a file is an HTML file
 */
export function isHtmlFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return ['html', 'htm', 'svelte', 'vue'].includes(ext);
}

/**
 * Check if a file is a CSS file
 */
export function isCssFile(filepath: string): boolean {
  const ext = filepath.split('.').pop()?.toLowerCase() || '';
  return ['css', 'scss', 'sass', 'less'].includes(ext);
}

/**
 * Format HTML document
 */
export async function formatHtmlDocument(
  editor: Monaco.editor.IStandaloneCodeEditor
): Promise<void> {
  await editor.getAction('editor.action.formatDocument')?.run();
}

/**
 * Format CSS document
 */
export async function formatCssDocument(
  editor: Monaco.editor.IStandaloneCodeEditor
): Promise<void> {
  await editor.getAction('editor.action.formatDocument')?.run();
}

/**
 * Trigger HTML/CSS autocomplete
 */
export function triggerAutocomplete(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
}

/**
 * Show color picker for CSS colors
 */
export function showColorPicker(
  editor: Monaco.editor.IStandaloneCodeEditor
): void {
  editor.trigger('keyboard', 'editor.action.showHover', {});
}


import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const root = new URL('..', import.meta.url);
const modulePath = new URL('spacetimedb/src/index.ts', root);
const bindingsDir = new URL('src/module_bindings/', root);
const bindingsIndexPath = new URL('src/module_bindings/index.ts', root);

const read = url => readFileSync(url, 'utf8');
const moduleSource = read(modulePath);
const bindingsIndex = read(bindingsIndexPath);
const moduleAst = ts.createSourceFile(
  modulePath.pathname,
  moduleSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);

const checks = [];
const moduleTables = new Map();
const moduleReducers = new Map();
const tableNameToVariable = new Map();
const requiredTables = [
  'turf',
  'voter',
  'volunteer',
  'activity_event',
  'turf_stats',
  'sim_state',
  'registered_voter',
];
const requiredReducers = [
  'importRegisteredVoters',
  'resetDemoData',
  'claimTurf',
  'updateVolunteerLocation',
  'updateVoterStatus',
  'completeTurf',
  'seedSimulation',
  'stopSimulation',
  'simulateTick',
];

const add = (name, passed, detail) => checks.push({ name, passed, detail });

function canonicalType(text) {
  return text
    .replace(/\s+/g, '')
    .replaceAll('__t.', 't.')
    .replaceAll('Coordinate', 'coordinate')
    .replaceAll('RegisteredVoterImportRow', 'registeredVoterImportRow')
    .replace(/\.name\(["'][^"']+["']\)/g, '');
}

function snakeCase(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function propertyNameText(nameNode) {
  if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) {
    return nameNode.text;
  }
  return undefined;
}

function normalizedFieldName(name) {
  return name.replace(/_(?=\d)/g, '');
}

function expressionDbName(expression) {
  if (!expression || !ts.isCallExpression(expression)) {
    return undefined;
  }

  if (
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === 'name' &&
    expression.arguments[0] &&
    ts.isStringLiteral(expression.arguments[0])
  ) {
    return expression.arguments[0].text;
  }

  if (ts.isPropertyAccessExpression(expression.expression)) {
    return expressionDbName(expression.expression.expression);
  }

  return undefined;
}

function getterReturnExpression(property) {
  for (const statement of property.body?.statements ?? []) {
    if (ts.isReturnStatement(statement) && statement.expression) {
      return statement.expression;
    }
  }
  return undefined;
}

function setField(fields, name, expression, sourceFile) {
  const dbName = expressionDbName(expression) ?? name;
  fields.set(
    normalizedFieldName(dbName),
    canonicalType(expression.getText(sourceFile))
  );
}

function objectFields(node, sourceFile) {
  if (!node || !ts.isObjectLiteralExpression(node)) {
    return new Map();
  }

  const fields = new Map();
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = propertyNameText(property.name);
      if (name) {
        setField(fields, name, property.initializer, sourceFile);
      }
      continue;
    }

    if (ts.isGetAccessorDeclaration(property)) {
      const name = propertyNameText(property.name);
      const expression = getterReturnExpression(property);
      if (name && expression) {
        setField(fields, name, expression, sourceFile);
      }
    }
  }

  return fields;
}

function tableConfigName(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) {
    return undefined;
  }

  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    if (propertyNameText(property.name) !== 'name') {
      continue;
    }

    if (ts.isStringLiteral(property.initializer)) {
      return property.initializer.text;
    }
  }

  return undefined;
}

function walkModule(node) {
  if (ts.isVariableStatement(node)) {
    const isExported = node.modifiers?.some(
      modifier => modifier.kind === ts.SyntaxKind.ExportKeyword
    );

    for (const declaration of node.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }

      const initializer = declaration.initializer;
      if (
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'table'
      ) {
        const tableName = tableConfigName(initializer.arguments[0]);
        if (tableName) {
          tableNameToVariable.set(tableName, declaration.name.text);
          moduleTables.set(
            tableName,
            objectFields(initializer.arguments[1], moduleAst)
          );
        }
      }

      if (
        isExported &&
        ts.isCallExpression(initializer) &&
        ts.isPropertyAccessExpression(initializer.expression) &&
        initializer.expression.name.text === 'reducer'
      ) {
        moduleReducers.set(
          declaration.name.text,
          objectFields(initializer.arguments[0], moduleAst)
        );
      }
    }
  }

  ts.forEachChild(node, walkModule);
}

function readBindingFields(file, rowWrapped) {
  const sourceText = read(file);
  const ast = ts.createSourceFile(
    file.pathname,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  let fields = new Map();
  function walk(node) {
    if (!ts.isExportAssignment(node) || node.isExportEquals) {
      ts.forEachChild(node, walk);
      return;
    }

    if (ts.isObjectLiteralExpression(node.expression)) {
      fields = objectFields(node.expression, ast);
    }

    if (
      rowWrapped &&
      ts.isCallExpression(node.expression) &&
      ts.isObjectLiteralExpression(node.expression.arguments[0])
    ) {
      fields = objectFields(node.expression.arguments[0], ast);
    }

    ts.forEachChild(node, walk);
  }
  walk(ast);
  return fields;
}

function compareFieldMaps(label, expected, actual) {
  const missing = [...expected.keys()].filter(key => !actual.has(key));
  const extra = [...actual.keys()].filter(key => !expected.has(key));
  const mismatched = [...expected.entries()].filter(
    ([key, value]) => actual.has(key) && actual.get(key) !== value
  );
  const passed =
    missing.length === 0 && extra.length === 0 && mismatched.length === 0;

  add(
    `${label} fields match`,
    passed,
    passed
      ? `${expected.size} fields`
      : [
          missing.length ? `missing=${missing.join(',')}` : '',
          extra.length ? `extra=${extra.join(',')}` : '',
          mismatched.length
            ? `mismatched=${mismatched
                .map(([key, value]) => `${key}:${value}->${actual.get(key)}`)
                .join(',')}`
            : '',
        ]
          .filter(Boolean)
          .join(' ')
  );
}

walkModule(moduleAst);

for (const [tableName, fields] of moduleTables) {
  const bindingFile = new URL(`${tableName}_table.ts`, bindingsDir);
  add(
    `${tableName} table binding file exists`,
    existsSync(bindingFile),
    bindingFile.pathname
  );

  if (existsSync(bindingFile)) {
    compareFieldMaps(
      `${tableName} table binding`,
      fields,
      readBindingFields(bindingFile, true)
    );
  }

  const variableName = tableNameToVariable.get(tableName);
  add(
    `${tableName} table is registered in bindings index`,
    Boolean(variableName) && bindingsIndex.includes(`${variableName}: __table(`),
    variableName ?? 'missing module variable'
  );
}

for (const [reducerName, fields] of moduleReducers) {
  const reducerDbName = snakeCase(reducerName);
  const bindingFile = new URL(`${reducerDbName}_reducer.ts`, bindingsDir);
  add(
    `${reducerDbName} reducer binding file exists`,
    existsSync(bindingFile),
    bindingFile.pathname
  );

  if (existsSync(bindingFile)) {
    compareFieldMaps(
      `${reducerDbName} reducer binding`,
      fields,
      readBindingFields(bindingFile, false)
    );
  }

  add(
    `${reducerDbName} reducer is registered in bindings index`,
    new RegExp(`__reducerSchema\\(["']${reducerDbName}["']`).test(
      bindingsIndex
    ),
    reducerDbName
  );
}

for (const tableName of requiredTables) {
  add(
    `${tableName} required table is present in module`,
    moduleTables.has(tableName),
    [...moduleTables.keys()].join(',')
  );
}

for (const reducerName of requiredReducers) {
  add(
    `${snakeCase(reducerName)} required reducer is present in module`,
    moduleReducers.has(reducerName),
    [...moduleReducers.keys()].join(',')
  );
}

const failed = checks.filter(check => !check.passed);
for (const check of checks) {
  console.log(
    `${check.passed ? 'PASS' : 'FAIL'}: ${check.name} (${check.detail})`
  );
}

if (failed.length > 0) {
  process.exitCode = 1;
}

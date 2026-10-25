// Dependency-free SQL emitter for the initial schema, used only before the root
// tool installation. Later schema changes must use Prisma migrate, not this file.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const schema = await readFile('prisma/schema.prisma', 'utf8');
const enums = [...schema.matchAll(/enum (\w+) \{([^}]+)\}/g)];
const models = [...schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)];
const enumNames = new Set(enums.map(match => match[1]));
const scalar = new Set(['String', 'Int', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes', 'BigInt']);
const q = value => `"${value.replaceAll('"', '""')}"`;
const sql = ['-- Initial persisted Swachh-Track schema. UUIDs are assigned by Prisma.', ''];
for (const [, name, body] of enums) sql.push(`CREATE TYPE ${q(name)} AS ENUM (${body.trim().split(/\s+/).map(v => `'${v}'`).join(', ')});`, '');
const indexes = []; const foreignKeys = [];
for (const [, model, body] of models) {
  const columns = []; let primary;
  for (const line of body.split('\n').map(l => l.trim()).filter(Boolean)) {
    const composite = line.match(/^@@(unique|index)\(\[([^\]]+)\]/);
    if (composite) {
      const fields = composite[2].split(',').map(s => s.trim());
      const name = `${model}_${fields.join('_')}_${composite[1] === 'unique' ? 'key' : 'idx'}`;
      indexes.push(`CREATE ${composite[1] === 'unique' ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${q(model)}(${fields.map(q).join(', ')});`); continue;
    }
    const field = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/);
    if (!field) throw new Error(`Unsupported schema line: ${line}`);
    const [, name, type, modifier, attributes] = field;
    if (!scalar.has(type) && !enumNames.has(type)) {
      const relation = attributes.match(/@relation\(fields:\s*\[([^\]]+)\],\s*references:\s*\[([^\]]+)\]/);
      if (relation) {
        const fields = relation[1].split(',').map(s => s.trim()); const refs = relation[2].split(',').map(s => s.trim());
        foreignKeys.push(`ALTER TABLE ${q(model)} ADD CONSTRAINT ${q(`${model}_${fields.join('_')}_fkey`)} FOREIGN KEY (${fields.map(q).join(', ')}) REFERENCES ${q(type)}(${refs.map(q).join(', ')}) ON DELETE ${modifier === '?' ? 'SET NULL' : 'RESTRICT'} ON UPDATE CASCADE;`);
      }
      continue;
    }
    let columnType = enumNames.has(type) ? q(type) : ({ String: 'TEXT', Int: 'INTEGER', Float: 'DOUBLE PRECISION', Decimal: 'DECIMAL(65,30)', Boolean: 'BOOLEAN', DateTime: 'TIMESTAMP(3)', Json: 'JSONB', Bytes: 'BYTEA', BigInt: 'BIGINT' })[type];
    if (attributes.includes('@db.Uuid')) columnType = 'UUID';
    if (attributes.includes('@db.Date') && !attributes.includes('@db.DateTime')) columnType = 'DATE';
    const decimal = attributes.match(/@db.Decimal\((\d+),\s*(\d+)\)/);
    if (decimal) columnType = `DECIMAL(${decimal[1]},${decimal[2]})`;
    if (modifier === '[]') columnType += '[]';
    let defaultSql = '';
    const text = attributes.match(/@default\(("(?:\\.|[^"\\])*")\)/);
    if (text) defaultSql = ` DEFAULT '${JSON.parse(text[1]).replaceAll("'", "''")}'`;
    else if (attributes.includes('@default(now())')) defaultSql = ' DEFAULT CURRENT_TIMESTAMP';
    else {
      const value = attributes.match(/@default\(([-\d.]+|true|false|[A-Z_]+)\)/);
      if (value) defaultSql = ` DEFAULT ${enumNames.has(type) ? `'${value[1]}'` : value[1]}`;
    }
    columns.push(`    ${q(name)} ${columnType}${modifier === '?' || modifier === '[]' ? '' : ' NOT NULL'}${defaultSql}`);
    if (attributes.includes('@id')) primary = name;
    if (attributes.includes('@unique')) indexes.push(`CREATE UNIQUE INDEX ${q(`${model}_${name}_key`)} ON ${q(model)}(${q(name)});`);
  }
  if (!primary) throw new Error(`No primary key on ${model}`);
  columns.push(`    CONSTRAINT ${q(`${model}_pkey`)} PRIMARY KEY (${q(primary)})`);
  sql.push(`CREATE TABLE ${q(model)} (\n${columns.join(',\n')}\n);`, '');
}
sql.push(...indexes, '', ...foreignKeys, '');
const directory = 'prisma/migrations/202610250001_initial';
await mkdir(directory, { recursive: true });
await writeFile(`${directory}/migration.sql`, sql.join('\n'));
console.info(`Generated initial SQL for ${models.length} models and ${enums.length} enums.`);

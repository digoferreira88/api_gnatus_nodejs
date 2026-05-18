// Service PostgreSQL com helper de COMPATIBILIDADE com a API do mssql.
//
// Mantém a mesma assinatura `connectAndQuery(sql, params)` usada em
// services/mssql.js, traduzindo na hora:
//   - placeholders @nome  →  $1, $2, ...   (estilo nativo do node-postgres)
//   - GETDATE()           →  NOW()
//   - WITH (NOLOCK)       →  removido (Postgres MVCC já não bloqueia leitura)
//
// O que NÃO é traduzido automaticamente (precisa ajustar no SQL do endpoint):
//   - OUTPUT INSERTED.X         → use RETURNING x
//   - SELECT TOP N               → use SELECT ... LIMIT N
//   - MERGE                      → use INSERT ... ON CONFLICT DO UPDATE
//   - CONVERT(date, str, 112)    → use TO_DATE(str, 'YYYYMMDD')
//   - DATEDIFF                   → use (date - date) (intervalo) ou EXTRACT
//   - IDENTITY                   → use SERIAL/IDENTITY na criação
//
// Esses casos estão concentrados em poucos arquivos do resources/ — vamos
// adaptar 1 a 1 durante a refatoração.

const { Pool } = require('pg');

if (!process.env.PG_PASSWORD) {
    throw new Error('PG_PASSWORD nao definido no .env — abortando boot (nao usa fallback hardcoded).');
}
const config = {
    host:     process.env.PG_HOST     || 'localhost',
    port:     Number(process.env.PG_PORT || 5432),
    database: process.env.PG_DATABASE || 'intranet',
    user:     process.env.PG_USER     || 'intranet',
    password: process.env.PG_PASSWORD,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
};

const pool = new Pool(config);
pool.on('error', (err) => console.error('Erro no pool Postgres:', err.message));

// Converte placeholders @nome → $1, $2... preservando a ordem de aparição.
// Suporta o mesmo nome aparecendo múltiplas vezes (mapeia para o mesmo $N).
const traduzirPlaceholders = (sql, params = {}) => {
    const ordem = [];        // valores na ordem que devem ir pra `pg`
    const indiceDe = {};     // nome → índice ($N)
    const novoSql = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, nome) => {
        if (!(nome in indiceDe)) {
            ordem.push(params[nome]);
            indiceDe[nome] = ordem.length;
        }
        return '$' + indiceDe[nome];
    });
    return { sql: novoSql, values: ordem };
};

// Tradução de funções/sintaxe MSSQL → Postgres frequentemente usadas no projeto.
// Aplicada antes do replace de placeholders.
const traduzirSintaxe = (sql) => {
    return sql
        // GETDATE() → NOW()
        .replace(/\bGETDATE\s*\(\s*\)/gi, 'NOW()')
        // WITH (NOLOCK) — apenas remover (apenas em queries do MSSQL Protheus, mas
        // se aparecer em query de Intranet por copy-paste, tratamos)
        .replace(/\bWITH\s*\(\s*NOLOCK\s*\)/gi, '')
        // SQL Server às vezes usa N'string' para strings unicode — Postgres não precisa
        .replace(/\bN'/g, "'");
};

// Postgres retorna nomes de coluna em lowercase por default. Para preservar
// compatibilidade com o código existente que faz `row.ID`, `row.NOME`,
// `row.EMAIL` (estilo MSSQL), duplicamos cada key adicionando o alias UPPERCASE.
// Não sobrescreve se já existir uppercase distinto.
const adicionarAliasesUpper = (rows) => {
    if (!Array.isArray(rows)) return rows;
    rows.forEach(row => {
        for (const k of Object.keys(row)) {
            const upper = k.toUpperCase();
            if (upper !== k && !(upper in row)) {
                row[upper] = row[k];
            }
        }
    });
    return rows;
};

// Função compatível com Mssql.connectAndQuery(sql, params)
async function connectAndQuery(sqlOriginal, params = {}) {
    const sqlPreparado = traduzirSintaxe(sqlOriginal);
    const { sql, values } = traduzirPlaceholders(sqlPreparado, params);
    try {
        const result = await pool.query(sql, values);
        return adicionarAliasesUpper(result.rows);
    } catch (err) {
        console.error('[pg] Erro:', err.message);
        console.error('[pg] SQL:', sql.slice(0, 300));
        throw err;
    }
}

// Helper para transações (usado em scripts de migração)
async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = {
    connectAndQuery,
    withTransaction,
    pool,
    // Expostos para debug/teste
    _traduzirPlaceholders: traduzirPlaceholders,
    _traduzirSintaxe: traduzirSintaxe
};

// Migra dados do MSSQL Intranet (localhost) para Postgres.
//
// Pré-requisitos:
//   1. docker compose up -d (Postgres rodando na 5432)
//   2. Schema aplicado:
//        docker exec -i intranet-pg psql -U intranet -d intranet < 01-schema.sql
//   3. .env do projeto configurado com PG_HOST/USER/PASS
//   4. MSSQL Intranet local acessível (Windows Auth ou usuário 'intranet')
//
// Uso (do raiz do backend):
//   node database/postgres/02-migrate-data.js
//
// O script é idempotente — pode rodar várias vezes. Antes de cada tabela,
// faz TRUNCATE no Postgres pra evitar duplicar.

require('dotenv').config();
const sql = require('mssql');
const { Pool } = require('pg');

// --- MSSQL (origem) ---------------------------------------------------------
const mssqlConfig = {
    user: process.env.DB_USER || 'intranet',
    password: process.env.DB_PASSWORD || '',
    server: process.env.DB_SERVER || 'localhost',
    database: process.env.DB_DATABASE || 'Intranet',
    options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true,
        ...(process.env.DB_TRUSTED_CONNECTION === 'true' ? { trustedConnection: true } : {})
    }
};

// --- Postgres (destino) -----------------------------------------------------
const pg = new Pool({
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5432),
    database: process.env.PG_DATABASE || 'intranet',
    user: process.env.PG_USER || 'intranet',
    password: process.env.PG_PASSWORD   // sem fallback: senha só no .env
});

// Tabelas em ordem topológica (FKs respeitadas).
// Cada item: { mssql, pg, columns: [{ms: 'COL_MSSQL', pg: 'col_pg', cast?: fn}] }
const tabelas = [
    {
        mssql: 'TAB_INTRANET_USR', pg: 'tab_intranet_usr',
        columns: [
            { ms: 'ID', pg: 'id' },
            { ms: 'NOME', pg: 'nome' },
            { ms: 'EMAIL', pg: 'email' },
            { ms: 'SENHA', pg: 'senha' },
            { ms: 'MATRICULA', pg: 'matricula' },
            { ms: 'ATIVO', pg: 'ativo', cast: v => !!v },
            { ms: 'COFRE_SALT', pg: 'cofre_salt' },
            { ms: 'COFRE_ITERATIONS', pg: 'cofre_iterations' },
            { ms: 'COFRE_VERIFIER', pg: 'cofre_verifier' },
            { ms: 'COFRE_MK_ENC_PASS', pg: 'cofre_mk_enc_pass' },
            { ms: 'COFRE_MK_ENC_RECOVERY', pg: 'cofre_mk_enc_recovery' },
            { ms: 'COFRE_CREATED_AT', pg: 'cofre_created_at' },
            { ms: 'CODIGO_PROTHEUS', pg: 'codigo_protheus' }
        ]
    },
    {
        mssql: 'TAB_INTRANET_PERMISSOES', pg: 'tab_intranet_permissoes',
        columns: [
            { ms: 'ID', pg: 'id' },
            { ms: 'ID_PERMISSAO', pg: 'id_permissao' },
            { ms: 'NOME', pg: 'nome' },
            { ms: 'MODULO', pg: 'modulo' }
        ]
    },
    {
        mssql: 'TAB_INTRANET_USR_PERMISSOES', pg: 'tab_intranet_usr_permissoes',
        columns: [
            { ms: 'ID', pg: 'id' },
            { ms: 'ID_USER', pg: 'id_user' },
            { ms: 'ID_PERMISSAO', pg: 'id_permissao' },
            { ms: 'MATRICULA', pg: 'matricula' }
        ]
    },
    {
        mssql: 'TAB_INTRANET_USR_FRANQUEADO', pg: 'tab_intranet_usr_franqueado',
        columns: [
            { ms: 'ID', pg: 'id' }, { ms: 'NOME', pg: 'nome' }, { ms: 'EMAIL', pg: 'email' },
            { ms: 'SENHA', pg: 'senha' }, { ms: 'MATRICULA', pg: 'matricula' },
            { ms: 'ATIVO', pg: 'ativo', cast: v => !!v }
        ]
    },
    {
        mssql: 'TAB_VERIFICACAO_INTRANET', pg: 'tab_verificacao_intranet',
        columns: [
            { ms: 'Email', pg: 'email' }, { ms: 'Codigo', pg: 'codigo' },
            { ms: 'DataExpiracao', pg: 'data_expiracao' }
        ]
    },
    {
        mssql: 'TAB_COFRE_ITEM', pg: 'tab_cofre_item',
        columns: [
            { ms: 'ID', pg: 'id' }, { ms: 'ID_USER', pg: 'id_user' }, { ms: 'TITULO', pg: 'titulo' },
            { ms: 'CATEGORIA', pg: 'categoria' }, { ms: 'URL', pg: 'url' },
            { ms: 'USUARIO_ENC', pg: 'usuario_enc' }, { ms: 'SENHA_ENC', pg: 'senha_enc' },
            { ms: 'NOTAS_ENC', pg: 'notas_enc' },
            { ms: 'CREATED_AT', pg: 'created_at' }, { ms: 'UPDATED_AT', pg: 'updated_at' }
        ]
    },
    {
        mssql: 'TAB_SYS_AUDIT_META', pg: 'tab_sys_audit_meta',
        columns: [
            { ms: 'META_ID', pg: 'meta_id' }, { ms: 'META_REF', pg: 'meta_ref' },
            { ms: 'META_HASH', pg: 'meta_hash' }, { ms: 'META_DATA', pg: 'meta_data' },
            { ms: 'META_CREATED', pg: 'meta_created' }, { ms: 'META_UPDATED', pg: 'meta_updated' },
            { ms: 'META_LAST_READ', pg: 'meta_last_read' }, { ms: 'META_READ_COUNT', pg: 'meta_read_count' }
        ]
    },
    {
        mssql: 'TAB_COBRANCA_ACAO', pg: 'tab_cobranca_acao',
        columns: [
            { ms: 'ID', pg: 'id' }, { ms: 'CLIENTE_COD', pg: 'cliente_cod' }, { ms: 'CLIENTE_LOJA', pg: 'cliente_loja' },
            { ms: 'TITULO_PREFIXO', pg: 'titulo_prefixo' }, { ms: 'TITULO_NUM', pg: 'titulo_num' },
            { ms: 'TITULO_PARCELA', pg: 'titulo_parcela' }, { ms: 'TITULO_TIPO', pg: 'titulo_tipo' },
            { ms: 'TIPO_ACAO', pg: 'tipo_acao' }, { ms: 'RESULTADO', pg: 'resultado' },
            { ms: 'DATA_PROMESSA', pg: 'data_promessa' }, { ms: 'VALOR_PROMETIDO', pg: 'valor_prometido' },
            { ms: 'DESCRICAO', pg: 'descricao' }, { ms: 'ID_USER', pg: 'id_user' },
            { ms: 'CRIADO_EM', pg: 'criado_em' }
        ]
    },
    {
        mssql: 'TAB_COBRANCA_COMENTARIO', pg: 'tab_cobranca_comentario',
        columns: [
            { ms: 'ID', pg: 'id' }, { ms: 'CLIENTE_COD', pg: 'cliente_cod' }, { ms: 'CLIENTE_LOJA', pg: 'cliente_loja' },
            { ms: 'ID_USER', pg: 'id_user' }, { ms: 'TEXTO', pg: 'texto' }, { ms: 'CRIADO_EM', pg: 'criado_em' }
        ]
    },
    {
        mssql: 'TAB_COBRANCA_STATUS_CLIENTE', pg: 'tab_cobranca_status_cliente',
        columns: [
            { ms: 'CLIENTE_COD', pg: 'cliente_cod' }, { ms: 'CLIENTE_LOJA', pg: 'cliente_loja' },
            { ms: 'STATUS', pg: 'status' }, { ms: 'OBSERVACAO', pg: 'observacao' },
            { ms: 'DT_ATUALIZACAO', pg: 'dt_atualizacao' }, { ms: 'ID_USER', pg: 'id_user' }
        ]
    },
    {
        mssql: 'TAB_EXP_BORDERO', pg: 'tab_exp_bordero',
        columns: [
            { ms: 'ID', pg: 'id' }, { ms: 'NOTAFISCAL', pg: 'notafiscal' }, { ms: 'SERIE', pg: 'serie' },
            { ms: 'DESTINATARIO', pg: 'destinatario' }, { ms: 'ENDERECO', pg: 'endereco' },
            { ms: 'CIDADE', pg: 'cidade' }, { ms: 'CEP', pg: 'cep' }, { ms: 'TRANSPORTADORA', pg: 'transportadora' },
            { ms: 'VOLUMES', pg: 'volumes' }, { ms: 'ID_USER', pg: 'id_user' }, { ms: 'CRIADO_EM', pg: 'criado_em' }
        ]
    },
    {
        mssql: 'TAB_APROVACAO_LOG', pg: 'tab_aprovacao_log',
        columns: [
            { ms: 'ID', pg: 'id' }, { ms: 'ID_USER', pg: 'id_user' }, { ms: 'CODIGO_PROTHEUS', pg: 'codigo_protheus' },
            { ms: 'TIPO_DOC', pg: 'tipo_doc' }, { ms: 'NUMERO_DOC', pg: 'numero_doc' },
            { ms: 'ACAO', pg: 'acao' }, { ms: 'JUSTIFICATIVA', pg: 'justificativa' },
            { ms: 'SUCESSO', pg: 'sucesso', cast: v => !!v }, { ms: 'RESPOSTA_PROTHEUS', pg: 'resposta_protheus' },
            { ms: 'IP_ORIGEM', pg: 'ip_origem' }, { ms: 'CRIADO_EM', pg: 'criado_em' }
        ]
    }
];

async function migrarTabela(mssqlPool, t) {
    process.stdout.write(`> ${t.mssql.padEnd(35)} `);

    // Lê tudo do MSSQL
    const colsList = t.columns.map(c => c.ms.includes(' ') ? `[${c.ms}]` : c.ms).join(', ');
    const r = await mssqlPool.request().query(`SELECT ${colsList} FROM ${t.mssql}`);
    const linhas = r.recordset;
    if (linhas.length === 0) {
        console.log('vazia');
        return;
    }

    // TRUNCATE Postgres (CASCADE pra resolver FKs)
    await pg.query(`TRUNCATE TABLE ${t.pg} RESTART IDENTITY CASCADE`);

    // Insere em batches
    const colsPg = t.columns.map(c => c.pg);
    const placeholders = (rowIdx) => `(${t.columns.map((_, i) => `$${rowIdx * t.columns.length + i + 1}`).join(',')})`;
    const BATCH = 200;
    let inseridas = 0;
    for (let i = 0; i < linhas.length; i += BATCH) {
        const chunk = linhas.slice(i, i + BATCH);
        const values = [];
        chunk.forEach(row => {
            t.columns.forEach(c => {
                let v = row[c.ms];
                if (typeof v === 'string') v = v.trim() === '' ? null : v;
                if (c.cast) v = c.cast(v);
                values.push(v ?? null);
            });
        });
        const sqlInsert = `INSERT INTO ${t.pg} (${colsPg.join(',')}) VALUES ${chunk.map((_, idx) => placeholders(idx)).join(',')}`;
        await pg.query(sqlInsert, values);
        inseridas += chunk.length;
    }

    // Reseta sequence se houver coluna 'id' SERIAL
    if (colsPg.includes('id')) {
        await pg.query(`SELECT setval(pg_get_serial_sequence('${t.pg}', 'id'), COALESCE((SELECT MAX(id) FROM ${t.pg}), 0) + 1, false)`);
    }
    if (colsPg.includes('meta_id')) {
        await pg.query(`SELECT setval(pg_get_serial_sequence('${t.pg}', 'meta_id'), COALESCE((SELECT MAX(meta_id) FROM ${t.pg}), 0) + 1, false)`);
    }

    console.log(`✓ ${inseridas} linhas`);
}

(async () => {
    console.log('=== Migração MSSQL → Postgres ===');
    console.log(`MSSQL: ${mssqlConfig.server}/${mssqlConfig.database}`);
    console.log(`PG:    ${process.env.PG_HOST || 'localhost'}/${process.env.PG_DATABASE || 'intranet'}`);
    console.log();
    let mssqlPool;
    try {
        mssqlPool = await sql.connect(mssqlConfig);
        for (const t of tabelas) {
            await migrarTabela(mssqlPool, t);
        }
        console.log('\n✓ Migração concluída.');
        process.exit(0);
    } catch (err) {
        console.error('\n✗ Erro:', err.message);
        process.exit(1);
    } finally {
        if (mssqlPool) await mssqlPool.close();
        await pg.end();
    }
})();

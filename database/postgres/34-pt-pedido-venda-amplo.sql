-- Poder de Terceiros: pedido_venda na pratica e usado pelo fiscal como
-- "campo de observacao da finalizacao" quando nao ha um pedido real
-- ("RETORNO VIRTUAL, BAIXA COMO PERDA", "FORNECEDOR DESCONHECE O COMODATO...",
-- "FICOU COMO AMOSTRA", etc). Antigo varchar(15) estourava nessas anotacoes.

ALTER TABLE tab_pt_finalizacao
  ALTER COLUMN pedido_venda TYPE varchar(200);

# Qualificação de Fornecedores — decisões, premissas e pendências

Para a Garantia da Qualidade e a Engenharia, **antes de ligar o módulo**.

Base documental:
- PRO 7.3.7 — Qualificação de Fornecedor, **REV OUT261 (29/10/2026)**.
- FORM 7.3.21 REV OUT26 (Cadastro e Avaliação de Fornecedores).
- FORM 7.3.24 (Lista de Qualificação de Fornecedores — Monitoramento).
- FORM 7.3.28 (Requalificação).
- FORM 7.4.3.H REV OUT25 (Relatório de Inspeção de Recebimento).

Situação do ensaio (banco de testes, 30/10/2026):
- **Importação:**
  - 3.305 fornecedores da FORM 7.3.24, dos quais 46 críticos (todos A ou B; nenhum em classe C ou D).
  - Mais 60 fornecedores que só existiam nas inspeções.
  - 6.465 inspeções.
  - **0 divergências** contra o IQF da planilha.
  - INFITEK (003794): 14 inspeções, IQF 10,2857, classe A — **confere**.
- **Sincronização com o Protheus (SA2):** 5.234 fornecedores lidos, 1.869 incluídos como não críticos.
- **Testes:** 20 automáticos das regras e 130 verificações ponta a ponta passando.

---

## Parte 1 — Decisões de 30/10/2026 (como o sistema ficou)

| # | Ponto | Decisão | Como o sistema faz |
|---|---|---|---|
| 1 | Tabela do índice P | Seguir o PRO 7.3.7 REV OUT261 | Três tabelas, ativas na versão de regra "PRO 7.3.7 REV OUT261". **Nacional:** atraso na **entrega**. **Importado:** atraso na **coleta**. **Antecipação:** vale para os dois. IQF máximo = 10. A tabela antiga da planilha fica guardada para o histórico importado. |
| 2 | Nº do Rel. Insp. | Sequencial | Continua a numeração da planilha, automática. Só a Administração informa outro número. |
| 3 | Perguntas do FORM 7.3.21 | Seguir o FORM 7.3.21 REV OUT26 | As **36 perguntas oficiais** (6 seções) estão cadastradas com a orientação ao fornecedor. Pergunta **em branco conta como NÃO** e o fornecedor é avisado antes de enviar. O % sai por seção e no total (≥ 70% aprovado, 50–69,99% com restrição, < 50% reprovado). |
| 4 | "Últimas 3 entregas" do N | **Fornecedor + item** (menos punitivo) | A janela olha as 3 entregas anteriores **do mesmo item** do fornecedor. Os códigos são comparados sem zeros à esquerda. |
| 4c | N < 1 sem NC no histórico | Provável erro de preenchimento | Importado como está, com aviso na linha (141 linhas). Filtro "com aviso de importação" no Recebimento. |
| 5 | Inativos e notas baixas | Inativo não aparece. **E (IQF < 5): reprova e inativa.** **D: bloqueia e só libera após o plano de ação da Engenharia; depois, só recebimento 100%.** **C: bloqueia e libera após o plano; depois volta a amostragem.** | Ver Parte 2. |
| 6 | Não críticos no IQF | Fora do monitoramento; o registro do recebimento continua | Não crítico **não recebe classe** nem entra no painel, ranking ou ações automáticas. As inspeções dele continuam sendo registradas normalmente. |
| 7 | Suspenso × pedido no ERP | Avisar a Engenharia para inativar | Cada bloqueio (C, D, E, documento vencido, requalificação vencida, suspensão manual) gera e-mail **"[Bloquear no Protheus]"** para a Engenharia e a Qualidade. Cada liberação gera **"[Liberar no Protheus]"**. |
| 8 | Reativação | Ao cair para D: inativar, campo para o plano de ação e local para anexar; sem plano, impedir o recebimento | Painel **"Plano de ação"** na ficha do fornecedor: texto + anexo (categoria Plano de ação). Sem plano, **ninguém** lança recebimento, nem a Qualidade. |
| 9 | FORM 7.3.24 ou 7.3.25 | **7.3.24** | Títulos e impressão: "FORM 7.3.24 - Lista de Qualificação de Fornecedores (Monitoramento)". |
| 10 | Integração com o ERP | Sem necessidade no momento | O módulo só **lê** o Protheus (SA2, SC7, SD1/SF1, SB1). A consulta `GET /qualificacao/status/{código}` está disponível. |
| d | "Qtd. Insp." é fórmula | Depende do nível de inspeção | O formulário preenche a quantidade inspecionada pela tabela do nível escolhido. O inspetor confirma o que de fato inspecionou (aprovada + reprovada = inspecionada). Nível "100" = lote inteiro. |
| f | Linhas "CQ/01" | Não entram | Ignoradas na importação. |
| g | 60 fornecedores só nas inspeções | Também entram | Criados como **não críticos** com a pendência "conferir os itens que fornece (criticidade)". |
| — | Criticidade | "O fornecedor é qualificado pela criticidade do item que fornece" | Há uma **Lista de Itens Críticos** (código do item → A, B, C ou D), mantida pela Engenharia. O fornecedor tem o **conjunto** das criticidades dos itens que fornece (ex.: A + B). A ficha do fornecedor sugere as criticidades a partir das notas de entrada dos últimos 24 meses × lista. Item crítico recebido de fornecedor não qualificado naquela criticidade gera alerta à Engenharia. |
| — | Escopo do go-live | "Apenas Recebimento momentaneamente" | Entendido como: liga-se primeiro a aba **Recebimento** (FORM 7.4.3.H + IQF). Qualificação, requalificação e documentos ficam prontos para a etapa seguinte. Ver Parte 4. |

---

## Parte 2 — Regras de classe (PRO 5.9 + decisão de 30/10)

Classes: **A** ≥ 9 · **B** ≥ 8 · **C** ≥ 7 · **D** ≥ 5 · **E** < 5. Valem só para fornecedor crítico.

| Classe | O que acontece automaticamente | Como libera |
|---|---|---|
| A, B | nada | — |
| C | Fica **Suspenso — aguardando plano de ação**. Recebimento bloqueado para todos. Aviso "[Bloquear no Protheus]". | A Engenharia registra o plano (texto + anexo). Volta ao status anterior e recebe **por amostragem**. |
| D | Igual à C e, além disso, marca **"inspeção 100%"**. | A Engenharia registra o plano. Recebe **só com o lote inteiro inspecionado**, até subir para C ou melhor. |
| E | **Reprovado e inativado** (some das listas). | Só por **nova qualificação** completa. Na reaprovação, a média do IQF recomeça do zero (o histórico continua visível). Sem isso, o mesmo histórico o reprovaria de novo no primeiro recebimento. |

- Piorar de classe exige um **novo** plano. O anterior fica na trilha.
- Melhorar de classe **não** libera um bloqueio sozinho. Melhorar para fora da D tira a exigência de 100%.

---

## Parte 3 — Premissas adotadas (confirmar)

1. **Importado com mais de 15 dias de atraso na coleta → P = 0,6.** O PRO OUT261 não define a faixa.
2. **Faixas do índice N** (0 NC = 1,0 · 1 = 0,9 · 2 = 0,8 · 3 = 0,7): o OUT261 não as traz; foram **mantidas da planilha**.
3. **Antecipação**: a mesma tabela vale para nacional e importado.
4. **Fornecedor com mais de uma criticidade** (ex.: A + B): cada documento é exigido pela regra mais forte entre elas.
5. **FORM 7.3.28** (requalificação): o formulário não foi enviado. O layout foi montado pelo texto do PRO 5.10:
   - atualização cadastral;
   - documentos — só os vencidos ou vencendo precisam ser reenviados;
   - declaração de alterações: processo, local de fabricação, matéria-prima, responsável técnico, certificações, registro ANVISA, outras;
   - aceite.
   **Enviar o formulário oficial** para conferirmos.
6. **Requalificação anual:** a qualificação vale **12 meses** a partir da aprovação. O aviso à Engenharia sai 60 e 30 dias antes. Vencida sem requalificação aprovada → **suspenso** até a conclusão (Nota 3).
   O resultado sugerido segue o PRO 5.10.2:
   - documentação obrigatória pendente/vencida, classe E, alteração não aceita ou formulário não devolvido → **não requalificado**;
   - protocolo ou classe C/D → **com restrição** (exige plano + prazo).
7. **Reativação de suspenso** (por documento, manual etc.): exige **auditoria de acompanhamento realizada depois da suspensão** (PRO 5.6.2) **ou** dispensa justificada pela Engenharia. Suspensão por documento só reativa com o documento regularizado.
8. **Auditoria de acompanhamento sugerida** (5.6.2): IQF < 7 em 2 avaliações seguidas, ou 3+ entregas com NC em 6 meses. Some quando uma auditoria é realizada depois do gatilho.
9. **Decisão de auditoria na qualificação inicial**: é da Engenharia, sempre com justificativa. O sistema só sugere (5.6.1: crítico B, ou A sem ISO).
10. **Documento por protocolo** exige o **prazo** de regularização. Prazo vencido = documento vencido (suspende o fornecedor, como um vencido).
11. **Avaliação de amostra** (FORM 7.3.22 / 7.3.23):
    - requisito marcado como **crítico** não atendido → **reprovado**;
    - "aprovado com restrição" exige o **acordo formal** registrado;
    - "não aplicável" exige justificativa.

---

## Parte 4 — Pendências para ligar

**Para ligar só o Recebimento (primeira etapa):**
1. **Engenharia: cadastrar a Lista de Itens Críticos** (aba Itens críticos — colar "código | A/B/C/D | descrição"). Hoje está vazia. Sem ela, nenhum item aparece como crítico no recebimento.
2. **Configuração: e-mails da Engenharia e da Qualidade.** Sem eles, os avisos "[Bloquear no Protheus]" ficam só registrados no módulo.
3. **Corrigir as datas digitadas no futuro** (18 inspeções: Rel. 18723–18728, 19282–19283, 20554–20563) e as 6 sem data. Filtro "com aviso de importação" → Editar, com motivo.
4. **Permissões:** conceder 23001 (consulta) / 23002 (inspetor) / 23003 (engenharia) / 23004 (qualidade) / 23005 (gerente de engenharia) / 23006 (administração).
5. **Ações automáticas por classe:** ligadas por padrão (decisão 30/10). Atenção: fornecedor crítico com poucas entregas pode cair para C/D com **um** lote ruim (ex.: 1 entrega nota 10 + 1 entrega nota 3 → média 6,5 → D → bloqueado). Se quiser um mínimo de inspeções antes de bloquear, é uma regra a acrescentar.

**Para a etapa de Qualificação/Requalificação:**
6. **46 críticos do legado sem data de qualificação.** A planilha não traz a data, então nenhum entra no aviso nem na suspensão por requalificação vencida. Eles aparecem como "requalificação sem data". **Decidir:** programar as requalificações (sugestão: distribuir ao longo de 12 meses) ou informar a data de aprovação de cada um.
7. **Documentos dos 46 críticos** não foram migrados (a planilha não tem arquivos nem validades). Todos aparecem com documentação pendente. Só ligar o alerta diário (`QF_ALERTAS_ATIVO=1`) **depois** de cadastrar os documentos — ligado, documento obrigatório vencido suspende o fornecedor.
8. **E-mail ao fornecedor** (questionário, documento vencendo, plano de ação): continua **desligado** até a Qualidade aprovar os textos. Desligado, a tela mostra o texto para envio manual.
9. **FORM 7.3.28 oficial** — ver premissa 5.

**Achados dos dados que continuam valendo:**
- **(h) Críticos com nota estranha:**
  - sem nota do questionário: 000373, 000887, 003345, 004937;
  - nota < 50: 003146 (42) e 004343 (6 — erro de digitação?), importados como "aprovado com restrição";
  - 000526 tinha 98 na coluna QUEST.
- **(j) Tabela de amostragem NBR 5426, nível I:** a faixa 281–500 está com Ac 0 / Re 1, mais rígida que a 151–280 (Ac 1 / Re 2). Copiada da planilha — **confirmar com a norma**.
- **(m) Data prevista do pedido (C7_DATPRF) pode ser alterada** pelo módulo de Compras. O P usa a data do momento da inspeção, e a tela avisa quando ela foi mexida. **Decidir** se o P deve usar a data original.
- **68 fornecedores bloqueados no Protheus** (A2_MSBLQL) continuam ativos no módulo — o bloqueio do ERP aparece só como informação. **Decidir** se o bloqueio do ERP deve inativar no módulo.

---

## Parte 5 — Checklist técnico de implantação

1. Aplicar a migration `133-qualificacao-fornecedores.sql` **como postgres** (`sudo cat … | sudo -u postgres psql -d intranet -v ON_ERROR_STOP=1`) e publicar backend + frontend.
2. Importar (Configuração → Importação): FORM 7.3.24 **Simular → Importar**; depois FORM 7.4.3.H **Simular** (conferir INFITEK 14 / 10,2857 / A) → **Importar** e conferir "0 divergências". Usar as planilhas do dia da virada; a partir daí, parar de lançar na planilha.
3. Sincronizar com o Protheus (Lista → Sincronizar SA2) para trazer os fornecedores que não estão na FORM 7.3.24.
4. Itens 1, 2 e 4 da Parte 4.
5. `QF_ALERTAS_ATIVO=1` só depois do item 7 da Parte 4.

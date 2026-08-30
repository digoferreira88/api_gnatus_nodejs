# Solicitação ao TI Protheus — Endpoint REST para retornar XML de NFe

Para a Intranet GNATUS poder gerar o DANFE em PDF a partir do XML da nota fiscal, precisamos de um endpoint REST simples no Protheus que devolva o conteúdo do XML pela chave da NFe.

## O que precisa ser entregue

Endpoint REST autenticado que receba a **chave de acesso da NFe** (44 dígitos) e retorne o **XML de autorização** completo (procNFe), normalmente o arquivo `<chave>-procNFe.xml` salvo na pasta de spool do Protheus.

**Padrão sugerido**:
```
GET /api/gnatus/v1/nfe/{chave}/xml
Headers: Authorization: Basic {user:pass} (mesmo padrão das APIs custom existentes)

Resposta 200 (success):
  Content-Type: application/xml
  Body: <conteúdo binário do .xml>

Resposta 404: { "message": "XML não encontrado" }
Resposta 401: { "message": "Não autenticado" }
```

## Caminho típico do arquivo

Por padrão TOTVS, o XML autorizado fica em:
```
%PROTHEUS_DATA%\spool\NFE\<filial>\<chave>-procNFe.xml
```

Variável de ambiente `MV_RELT` ou `MV_DIRDOC` aponta a raiz. O caminho exato pode variar conforme configuração do ambiente.

## ⚠️ VERSÃO FALLBACK (compatível com mais versões TOTVS)

Se a versão A com `PATH "/api/gnatus/v1/nfe/{cChave}/xml"` não registrar (versão TOTVS antiga não aceita path dinâmico), use esta versão B com **query string fixa**:

**Rota nova**: `GET /rest/gntnfe/xml?chave=XXXX`

```advpl
#INCLUDE "TOTVS.CH"
#INCLUDE "RESTFUL.CH"
#INCLUDE "FILEIO.CH"

WSRESTFUL GNTNFE DESCRIPTION "API GNATUS - NFe XML"
    WSDATA chave AS STRING

    WSMETHOD GET DESCRIPTION "Retorna XML da NFe pela chave (querystring)" WSSYNTAX "/gntnfe/xml"
END WSRESTFUL

WSMETHOD GET WSSERVICE GNTNFE
    Local cChaveLimpa := AllTrim(::aQueryString[1,2])  // primeira chave da QS
    Local cFilial     := ""
    Local cCaminho    := ""
    Local cBuffer     := ""
    Local nHandle     := 0
    Local nTamanho    := 0
    Local aBusca      := {}
    Local i           := 0

    // Pega valor da QS chamada "chave" (independente de ordem)
    For i := 1 To Len(::aQueryString)
        If Lower(AllTrim(::aQueryString[i,1])) == "chave"
            cChaveLimpa := AllTrim(::aQueryString[i,2])
            Exit
        EndIf
    Next

    If Len(cChaveLimpa) != 44 .Or. !IsDigit(cChaveLimpa)
        ::SetStatus(400)
        ::SetResponse('{"message":"Chave invalida (deve ter 44 digitos numericos)"}')
        Return .F.
    EndIf

    BeginSql Alias "QSF2"
        SELECT %notDel%, F2_FILIAL FROM %table:SF2% SF2
         WHERE SF2.D_E_L_E_T_ <> '*'
           AND SF2.F2_CHVNFE = %exp:cChaveLimpa%
    EndSql

    If QSF2->(EOF())
        QSF2->(DbCloseArea())
        ::SetStatus(404)
        ::SetResponse('{"message":"NFe nao encontrada"}')
        Return .F.
    EndIf

    cFilial := AllTrim(QSF2->F2_FILIAL)
    QSF2->(DbCloseArea())

    // Estrutura confirmada Gnatus (abr/2026):
    //   F:\TOTVS12\Microsiga\Protheus_Data\<chave>-nfe.xml  (raiz mesmo, sem subpasta)
    // Path relativo ao rootpath = "\<chave>-nfe.xml"
    aBusca := {}
    AAdd(aBusca, "\" + cChaveLimpa + "-nfe.xml")                                          // Gnatus padrao atual
    AAdd(aBusca, GetMv("MV_DIRDOC", .F., "") + "\NFE\" + cFilial + "\" + cChaveLimpa + "-procNFe.xml")
    AAdd(aBusca, "\spool\NFE\" + cFilial + "\" + cChaveLimpa + "-procNFe.xml")
    AAdd(aBusca, "\spool\" + cChaveLimpa + "-procNFe.xml")
    AAdd(aBusca, "\spool\NFE\" + cChaveLimpa + "-procNFe.xml")

    For i := 1 To Len(aBusca)
        If File(aBusca[i])
            cCaminho := aBusca[i]
            Exit
        EndIf
    Next

    If Empty(cCaminho)
        ::SetStatus(404)
        ::SetResponse('{"message":"XML nao encontrado no disco"}')
        Return .F.
    EndIf

    nHandle := FOpen(cCaminho, FO_READ)
    nTamanho := FSeek(nHandle, 0, FS_END)
    FSeek(nHandle, 0, FS_SET)
    cBuffer := Space(nTamanho)
    FRead(nHandle, @cBuffer, nTamanho)
    FClose(nHandle)

    ::SetContentType("application/xml; charset=utf-8")
    ::SetResponse(cBuffer)
Return .T.
```

**Teste rápido após compilar + restart REST**:
```bash
curl -u admin:<PROTHEUS_API_PASS do .env> "http://protheus.gnatus.com.br:8081/rest/gntnfe/xml?chave=35260409609356000100550010000872901442521059"
```

Se essa versão B funcionar e a versão A não, é confirmado que é incompatibilidade do path dinâmico. Pode ficar com a B mesmo — funciona igual.

---

## Template ADVPL (REST POST/GET)

Esse template usa o framework REST nativo do Protheus (a partir do 12.1.27). Funciona junto com as outras rotas custom já em uso na Gnatus (porta 8091).

```advpl
#INCLUDE "TOTVS.CH"
#INCLUDE "RESTFUL.CH"
#INCLUDE "FILEIO.CH"

/*/{Protheus.doc} GNTNFE
Servico REST para retornar XML de NFe pela chave de acesso.
Usado pela Intranet GNATUS para gerar DANFE em PDF.

@author     TI Gnatus / Intranet
@since      2026-04
@version    1.0
/*/

WSRESTFUL GNTNFE DESCRIPTION "API GNATUS - NFe XML"
    WSDATA cChave AS STRING

    WSMETHOD GET XMLPORC ;
        DESCRIPTION "Retorna XML autorizado da NFe pela chave" ;
        WSSYNTAX "/api/gnatus/v1/nfe/{cChave}/xml" ;
        PATH "/api/gnatus/v1/nfe/{cChave}/xml" ;
        PRODUCES APPLICATION_XML
END WSRESTFUL


WSMETHOD GET XMLPORC WSRECEIVE cChave WSSERVICE GNTNFE
    Local cChaveLimpa := AllTrim(::cChave)
    Local cFilial     := ""
    Local cCaminho    := ""
    Local cConteudo   := ""
    Local nHandle     := 0
    Local nTamanho    := 0
    Local cBuffer     := ""
    Local aBusca      := {}

    // Validacao basica: chave deve ter 44 digitos numericos
    If Len(cChaveLimpa) != 44 .Or. !IsDigit(cChaveLimpa)
        ::SetStatus(400)
        ::SetResponse('{"message":"Chave invalida (deve ter 44 digitos numericos)"}')
        Return .F.
    EndIf

    // Localiza a NF na SF2 pra confirmar que existe (e pegar a filial)
    BeginSql Alias "QSF2"
        SELECT %notDel%, F2_FILIAL, F2_DOC, F2_SERIE, F2_CHVNFE
          FROM %table:SF2% SF2
         WHERE SF2.D_E_L_E_T_ <> '*'
           AND SF2.F2_CHVNFE = %exp:cChaveLimpa%
    EndSql

    If QSF2->(EOF())
        QSF2->(DbCloseArea())
        ::SetStatus(404)
        ::SetResponse('{"message":"NFe nao encontrada (chave nao existe na SF2)"}')
        Return .F.
    EndIf

    cFilial := AllTrim(QSF2->F2_FILIAL)
    QSF2->(DbCloseArea())

    // Caminho do XML autorizado (procNFe). Ajustar conforme ambiente Gnatus:
    //   - GetMv("MV_DIRDOC") + "\NFE\" + filial + "\" + chave + "-procNFe.xml"
    //   - GetMv("MV_RELT")   + "\NFE\" + ...
    //   - "C:\protheus_data\spool\NFE\" + filial + "\" + ...
    //
    // Vamos tentar 2 caminhos comuns e usar o primeiro que existir.
    aBusca := {}
    AAdd(aBusca, GetMv("MV_DIRDOC", .F., "") + "\NFE\" + cFilial + "\" + cChaveLimpa + "-procNFe.xml")
    AAdd(aBusca, "\spool\NFE\" + cFilial + "\" + cChaveLimpa + "-procNFe.xml")
    AAdd(aBusca, "\spool\" + cChaveLimpa + "-procNFe.xml")
    AAdd(aBusca, "\spool\NFE\" + cChaveLimpa + "-procNFe.xml")

    cCaminho := ""
    For nHandle := 1 To Len(aBusca)
        If File(aBusca[nHandle])
            cCaminho := aBusca[nHandle]
            Exit
        EndIf
    Next

    If Empty(cCaminho)
        ::SetStatus(404)
        ::SetResponse('{"message":"Arquivo XML nao encontrado nas pastas conhecidas","tentativas":' + ;
            FormataJsonArray(aBusca) + '}')
        Return .F.
    EndIf

    // Le o conteudo do arquivo
    nHandle := FOpen(cCaminho, FO_READ)
    If nHandle == -1
        ::SetStatus(500)
        ::SetResponse('{"message":"Erro ao abrir arquivo: ' + Str(FError()) + '"}')
        Return .F.
    EndIf

    nTamanho := FSeek(nHandle, 0, FS_END)
    FSeek(nHandle, 0, FS_SET)
    cBuffer := Space(nTamanho)
    FRead(nHandle, @cBuffer, nTamanho)
    FClose(nHandle)

    // Devolve o XML cru
    ::SetContentType("application/xml; charset=utf-8")
    ::SetResponse(cBuffer)
Return .T.


// Helper pra formatar array como JSON (debug do erro 404)
Static Function FormataJsonArray(aArr)
    Local cRet := "["
    Local i
    For i := 1 To Len(aArr)
        cRet += '"' + StrTran(aArr[i], '\', '\\') + '"'
        If i < Len(aArr) ; cRet += "," ; EndIf
    Next
    cRet += "]"
Return cRet
```

## Como instalar/testar

1. Salvar o arquivo como `GNTNFE.PRW` na pasta de fontes do Protheus (RPO custom da Gnatus)
2. Compilar via SmartClient (ou linha de comando)
3. Reiniciar o serviço REST do Protheus

> **Sugestão de porta**: usar **8081** (mesma porta onde as APIs CRM/Documents custom já rodam — credenciais do usuário de integração (`PROTHEUS_API_USER/PASS` no .env) testadas e funcionais). O script de teste abaixo está com 8282; ajustar conforme onde o TI publicar.

4. Rodar o script de teste abaixo:

```bash
USER="usuario"; PASS="senha"
BASE="http://protheus.gnatus.com.br:8282/rest"
CHAVE_OK="35260409609356000100550010000872901442521059"
CHAVE_INV="123"
CHAVE_NX="00000000000000000000000000000000000000000000"
mkdir -p xml-baixados

echo "=== T1: 200 (sucesso) ==="
curl -u "$USER:$PASS" -w "\nHTTP %{http_code}\n" \
     -o "xml-baixados/nfe-$CHAVE_OK.xml" \
     "$BASE/api/gnatus/v1/nfe/$CHAVE_OK/xml"
head -c 200 "xml-baixados/nfe-$CHAVE_OK.xml"; echo

echo -e "\n=== T2: verbose ==="
curl -u "$USER:$PASS" -v -o /dev/null \
     "$BASE/api/gnatus/v1/nfe/$CHAVE_OK/xml" 2>&1 | grep -E "^(>|<) " | head -20

echo -e "\n=== T3: 400 (chave invalida) ==="
curl -u "$USER:$PASS" -w "\nHTTP %{http_code}\n" -i \
     "$BASE/api/gnatus/v1/nfe/$CHAVE_INV/xml"

echo -e "\n=== T4: 404 (nao existe) ==="
curl -u "$USER:$PASS" -w "\nHTTP %{http_code}\n" -i \
     "$BASE/api/gnatus/v1/nfe/$CHAVE_NX/xml"

echo -e "\n=== T5: 401 (sem auth) ==="
curl -w "\nHTTP %{http_code}\n" -i \
     "$BASE/api/gnatus/v1/nfe/$CHAVE_OK/xml"
```

**Resultados esperados** (preencher após o TI subir):
- T1: HTTP 200, arquivo XML válido com `<?xml version="1.0"...>` no início
- T2: headers `200 OK` + `Content-Type: application/xml`
- T3: HTTP 400 + JSON `{"message":"Chave invalida..."}`
- T4: HTTP 404 + JSON `{"message":"NFe nao encontrada..."}`
- T5: HTTP 401 + WWW-Authenticate Basic

## Como a Intranet vai consumir

Após o endpoint estar no ar, o backend Node da intranet vai:
1. Receber chamada do frontend: `GET /sac/nota/danfe?chave=XXX`
2. Chamar o endpoint do Protheus pra baixar o XML
3. Gerar o PDF do DANFE a partir do XML usando biblioteca Node (ex: `node-danfe`)
4. Devolver o PDF pro browser (download/preview)

O usuário não precisa fazer nada além de criar o endpoint REST. A geração do DANFE fica no nosso lado.

## Observações de segurança

- Endpoint deve ficar atrás da mesma autenticação Basic Auth das APIs custom existentes
- IP de origem deve ser restrito ao IP da VPS da intranet (`177.7.37.251`) via firewall
- Não logar o conteúdo do XML (contém dados fiscais sensíveis)

## Caminho alternativo (se preferir)

Se for mais fácil expor diretamente a pasta via Nginx/IIS rodando no servidor Protheus (sem ADVPL), basta:
- Servir `/spool/NFE/` como path estático
- Proteger com Basic Auth + restrição de IP
- Url ficaria: `http://protheus.gnatus.com.br:PORTA/spool/NFE/{filial}/{chave}-procNFe.xml`

Esta opção é ainda mais simples — não precisa programar ADVPL.

---

**Contato**: qualquer dúvida na implementação, falar com o time da Intranet (TI / desenvolvedor responsável).

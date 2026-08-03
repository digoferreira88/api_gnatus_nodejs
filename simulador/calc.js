/* Simulador de Margens Gnatus Franqueado — motor de cálculo + base de dados.
 * Puro (sem DOM): roda no browser (window.SIM) e no Node (module.exports) p/ testes.
 * Todos os cálculos client-side. Percentuais no state são FRAÇÕES (0.08 = 8%). */
(function (global) {
  'use strict';

  // ---- 2.2 Estados: ICMS interno (débito de saída) e interestadual (crédito) ----
  const ESTADOS = [
    { uf: 'AC', nome: 'Acre', interno: 0.17, inter: 0.07 },
    { uf: 'AL', nome: 'Alagoas', interno: 0.19, inter: 0.07 },
    { uf: 'AM', nome: 'Amazonas', interno: 0.20, inter: 0.07 },
    { uf: 'AP', nome: 'Amapá', interno: 0.18, inter: 0.07 },
    { uf: 'BA', nome: 'Bahia', interno: 0.19, inter: 0.07 },
    { uf: 'CE', nome: 'Ceará', interno: 0.20, inter: 0.07 },
    { uf: 'DF', nome: 'Distrito Federal', interno: 0.18, inter: 0.07 },
    { uf: 'ES', nome: 'Espírito Santo', interno: 0.17, inter: 0.12 },
    { uf: 'GO', nome: 'Goiás', interno: 0.17, inter: 0.07 },
    { uf: 'MA', nome: 'Maranhão', interno: 0.22, inter: 0.07 },
    { uf: 'MG', nome: 'Minas Gerais', interno: 0.18, inter: 0.12 },
    { uf: 'MS', nome: 'Mato Grosso do Sul', interno: 0.17, inter: 0.07 },
    { uf: 'MT', nome: 'Mato Grosso', interno: 0.17, inter: 0.07 },
    { uf: 'PA', nome: 'Pará', interno: 0.19, inter: 0.07 },
    { uf: 'PB', nome: 'Paraíba', interno: 0.18, inter: 0.07 },
    { uf: 'PE', nome: 'Pernambuco', interno: 0.205, inter: 0.07 },
    { uf: 'PI', nome: 'Piauí', interno: 0.21, inter: 0.07 },
    { uf: 'PR', nome: 'Paraná', interno: 0.19, inter: 0.12 },
    { uf: 'RJ', nome: 'Rio de Janeiro', interno: 0.22, inter: 0.12 },
    { uf: 'RN', nome: 'Rio Grande do Norte', interno: 0.20, inter: 0.07 },
    { uf: 'RO', nome: 'Rondônia', interno: 0.175, inter: 0.07 },
    { uf: 'RR', nome: 'Roraima', interno: 0.17, inter: 0.07 },
    { uf: 'RS', nome: 'Rio Grande do Sul', interno: 0.17, inter: 0.12 },
    { uf: 'SC', nome: 'Santa Catarina', interno: 0.17, inter: 0.12 },
    { uf: 'SE', nome: 'Sergipe', interno: 0.19, inter: 0.07 },
    { uf: 'SP', nome: 'São Paulo', interno: 0.18, inter: 0.12 },
    { uf: 'TO', nome: 'Tocantins', interno: 0.20, inter: 0.07 }
  ];

  // ---- 2.1 Produtos (base COMPLETA Junho/2026).
  // Gerado por gen-produtos.js a partir de docs/Simulador_Gnatus_Franqueado.xlsx (aba Produtos). id = chave única.
  const PRODUTOS = [
    {"id":1,"linha":"G4","produto":"CONSULTORIO G4 H","origem":"Nacional","atacado":47444.11,"promoPct":0,"t15":75712.83,"t13":68141.55,"t11":64734.47,"t8":62145.09,"brindes":"Kit Ultrassom F (5 insertos)","promoDesc":"GANHE KIT ULTRASSOM N2 LED + ESTOJO DE 5 INSERTOS + COURO"},
    {"id":2,"linha":"G4","produto":"CONSULTORIO G4 F","origem":"Nacional","atacado":45020.42,"promoPct":0,"t15":71845.04,"t13":64660.54,"t11":61427.51,"t8":58970.41,"brindes":"Upgrade Estofamento Couro","promoDesc":"GANHE ESTOFAMENTO EM COURO"},
    {"id":3,"linha":"G4","produto":"UPGRADE PARA ESTOFAMENTO COURO (CADEIRA + MOCHO)","origem":"Nacional","atacado":2847.65,"promoPct":0,"t15":4609.59,"t13":4148.63,"t11":3941.2,"t8":3783.55,"brindes":null,"promoDesc":null},
    {"id":4,"linha":"G4","produto":"KIT CAIXA DE LIGAÇÃO PADRÃO","origem":"Nacional","atacado":1411.83,"promoPct":0,"t15":2285.38,"t13":2056.84,"t11":1954,"t8":1875.84,"brindes":null,"promoDesc":null},
    {"id":5,"linha":"G4","produto":"KIT MASSAGEADOR GNATUS RELAX NEW (SOMENTE PARA COMPRA JUNTO...","origem":"Nacional","atacado":1142.75,"promoPct":0,"t15":1876.23,"t13":1688.61,"t11":1604.18,"t8":1540.01,"brindes":null,"promoDesc":null},
    {"id":6,"linha":"G4","produto":"SOFT CONFORT CABEÇA","origem":"Nacional","atacado":203.54,"promoPct":0,"t15":334.19,"t13":300.77,"t11":285.73,"t8":274.3,"brindes":null,"promoDesc":null},
    {"id":7,"linha":"G4","produto":"KIT AQUECEDOR AGUA SERINGA UA/ EQ PADRÃO","origem":"Nacional","atacado":1267.24,"promoPct":0,"t15":1995.13,"t13":1795.62,"t11":1705.84,"t8":1637.6,"brindes":null,"promoDesc":null},
    {"id":8,"linha":"G4","produto":"KIT TERM BORDEN P/ EQ F (TODOS MODELOS)","origem":"Nacional","atacado":744.27,"promoPct":0,"t15":1171.76,"t13":1054.58,"t11":1001.85,"t8":961.78,"brindes":null,"promoDesc":null},
    {"id":9,"linha":"G4","produto":"KIT TERMINAL BORDEN EQUIPO H","origem":"Nacional","atacado":856.71,"promoPct":0,"t15":1330.57,"t13":1197.51,"t11":1137.64,"t8":1092.13,"brindes":null,"promoDesc":null},
    {"id":10,"linha":"G4","produto":"KIT ULTRASSOM F (ACOMPANHA 5 INSERTOS)","origem":"Importado","atacado":2173.29,"promoPct":0.1,"t15":3784.49,"t13":3406.04,"t11":3235.74,"t8":3106.31,"brindes":null,"promoDesc":"10% DE DESCONTO ADICIONAL"},
    {"id":11,"linha":"G4","produto":"KIT ULTRASSOM H (ACOMPANHA 5 INSERTOS)","origem":"Importado","atacado":2281.83,"promoPct":0,"t15":3914.19,"t13":3522.77,"t11":3346.64,"t8":3212.77,"brindes":null,"promoDesc":null},
    {"id":12,"linha":"G4","produto":"KIT MICROMOTOR ELETRICO ELITE 100 (DE EMBUTIR, SEM PAINEL,...","origem":"Importado","atacado":6127.98,"promoPct":0.2,"t15":10061.29,"t13":9055.16,"t11":8602.41,"t8":8258.31,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL"},
    {"id":13,"linha":"G4","produto":"KIT MICROMOTOR ELETRICO ELITE 100 (DE EMBUTIR, SEM PAINEL,... #2","origem":"Importado","atacado":6339.39,"promoPct":0,"t15":10408.39,"t13":9367.55,"t11":8899.18,"t8":8543.21,"brindes":null,"promoDesc":null},
    {"id":14,"linha":"G4","produto":"KIT MICROMOTOR ELÉTRICO ELITE 200 - EQUIPO F (EMBUTIR COM...","origem":"Importado","atacado":7052.17,"promoPct":0,"t15":11580.29,"t13":10422.26,"t11":9901.15,"t8":9505.1,"brindes":null,"promoDesc":null},
    {"id":15,"linha":"G4","produto":"KIT MICROMOTOR ELÉT. ELITE 200 - EQUIPO H (EMBUTIR COM...","origem":"Importado","atacado":7338.78,"promoPct":0,"t15":12050.94,"t13":10845.84,"t11":10303.55,"t8":9891.41,"brindes":null,"promoDesc":null},
    {"id":16,"linha":"G4","produto":"MM ELETRICO COM  CONSOLE PORTÁTIL SEM CONTRA ÂNGULO MULTIPLICADOR","origem":"Importado","atacado":7362.44,"promoPct":0.2,"t15":12088.1,"t13":10879.29,"t11":10335.33,"t8":9921.91,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL"},
    {"id":17,"linha":"G4","produto":"PECA DE MAO CONTRA ANGULAR M5 PB","origem":"Importado","atacado":2588.25,"promoPct":0.4,"t15":4249.54,"t13":3824.59,"t11":3633.36,"t8":3488.02,"brindes":null,"promoDesc":"40% DE DESCONTO ADICIONAL"},
    {"id":18,"linha":"G4","produto":"JATO DE BICARBONATO JET HAND TB","origem":"Importado","atacado":300.29,"promoPct":0,"t15":513.58,"t13":462.22,"t11":439.11,"t8":421.55,"brindes":null,"promoDesc":null},
    {"id":19,"linha":"G4","produto":"KIT TERMINAL JATO DE BICARBONATO EQ. F (KIT COMPLETO COM PEÇA...","origem":"Nacional","atacado":1328.44,"promoPct":0,"t15":2181.12,"t13":1963.01,"t11":1864.86,"t8":1790.26,"brindes":null,"promoDesc":null},
    {"id":20,"linha":"G4","produto":"KIT TERMINAL JATO DE BICARBONATO EQ. H ( KIT COMPLETO COM...","origem":"Nacional","atacado":1328.44,"promoPct":0,"t15":2181.12,"t13":1963.01,"t11":1864.86,"t8":1790.26,"brindes":null,"promoDesc":null},
    {"id":21,"linha":"G4","produto":"KIT TERMINAL SERINGA INJETADA UA","origem":"Nacional","atacado":1048.59,"promoPct":0,"t15":1650.89,"t13":1485.8,"t11":1411.51,"t8":1355.05,"brindes":null,"promoDesc":null},
    {"id":22,"linha":"G4","produto":"KIT TERMINAL SUCTOR VENTURI UA G3/G4/G8","origem":"Nacional","atacado":692.19,"promoPct":0,"t15":1089.78,"t13":980.8,"t11":931.76,"t8":894.49,"brindes":null,"promoDesc":null},
    {"id":23,"linha":"G4","produto":"KIT TERMINAL SUCTOR BV UA G3/G4","origem":"Nacional","atacado":650.48,"promoPct":0,"t15":1024.11,"t13":921.7,"t11":875.61,"t8":840.59,"brindes":null,"promoDesc":null},
    {"id":24,"linha":"G4","produto":"KIT TERMINAL SUCTOR VAC PLUS UA G3/G4","origem":"Nacional","atacado":1080.99,"promoPct":0,"t15":1774.83,"t13":1597.35,"t11":1517.48,"t8":1456.78,"brindes":null,"promoDesc":null},
    {"id":25,"linha":"G4","produto":"CAMERA DIGITAL INTRAORAL E CORPORAL TIMEX 1H","origem":"Importado","atacado":5546.96,"promoPct":0.15,"t15":8388.33,"t13":7549.5,"t11":7172.02,"t8":6885.14,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":26,"linha":"G4","produto":"CAMERA DIGITAL INTRAORAL E CORPORAL TIMEX 2H","origem":"Importado","atacado":4038.78,"promoPct":0,"t15":6107.61,"t13":5496.85,"t11":5222.01,"t8":5013.13,"brindes":null,"promoDesc":null},
    {"id":27,"linha":"G4","produto":"SUPORTE MONITOR P/ CONSULTÓRIO ORIGINAL GNATUS (G1, G2, G3 E G4)","origem":"Importado","atacado":1500.52,"promoPct":0,"t15":2463.63,"t13":2217.27,"t11":2106.4,"t8":2022.15,"brindes":null,"promoDesc":null},
    {"id":28,"linha":"G4","produto":"ALL IN ONE 21,5 POL PROCESSADOR I3-3120M 8GB RAM 128 GB SSD...","origem":"Importado","atacado":4424.28,"promoPct":0.15,"t15":7062.28,"t13":6356.05,"t11":6038.25,"t8":5796.72,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":29,"linha":"G4","produto":"CART G-TOTEM (SEM MONITOR)","origem":"Importado","atacado":3800.16,"promoPct":0.15,"t15":5898.27,"t13":5308.44,"t11":5043.02,"t8":4841.3,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL NA COMPRA DO KIT MULTIMIDIA DENTRO DA TABELA"},
    {"id":30,"linha":"G4","produto":"SENSOR RADIOLOGICO DIGITAL TIMEX 1H","origem":"Importado","atacado":8438.06,"promoPct":0.2,"t15":14900.35,"t13":13410.32,"t11":12739.8,"t8":12230.21,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL + POSICIONADOR"},
    {"id":31,"linha":"G4","produto":"SENSOR RADIOLOGICO DIGITAL TIMEX 2H","origem":"Importado","atacado":9647.85,"promoPct":0,"t15":17356.96,"t13":15621.26,"t11":14840.2,"t8":14246.59,"brindes":null,"promoDesc":null},
    {"id":32,"linha":"G4","produto":"KIT BANDEJA AUXILIAR PLASTICA","origem":"Nacional","atacado":342.83,"promoPct":0,"t15":562.87,"t13":506.58,"t11":481.25,"t8":462,"brindes":null,"promoDesc":null},
    {"id":33,"linha":"G3","produto":"CONSULTORIO G3 H","origem":"Nacional","atacado":34295.43,"promoPct":0,"t15":57997.2,"t13":52197.48,"t11":49587.6,"t8":47604.1,"brindes":"Kit Massageador Relax New; Kit Ultrassom F (5 insertos)","promoDesc":"GANHE 1 KIT MASSAGEADOR + ULTRASSOM N2 LED"},
    {"id":34,"linha":"G3","produto":"CONSULTORIO G3 F","origem":"Nacional","atacado":31912.85,"promoPct":0,"t15":53968.01,"t13":48571.21,"t11":46142.65,"t8":44296.94,"brindes":"Kit Massageador Relax New; Kit Ultrassom F (5 insertos)","promoDesc":"GANHE 1 KIT MASSAGEADOR + ULTRASSOM N2 LED"},
    {"id":35,"linha":"G3","produto":"UPGRADE PARA ESTOFAMENTO COURO (CADEIRA + MOCHO)","origem":"Nacional","atacado":2847.65,"promoPct":0,"t15":4609.59,"t13":4148.63,"t11":3941.2,"t8":3783.55,"brindes":null,"promoDesc":null},
    {"id":36,"linha":"G3","produto":"KIT CAIXA DE LIGAÇÃO PADRÃO","origem":"Nacional","atacado":1411.83,"promoPct":0,"t15":2285.38,"t13":2056.84,"t11":1954,"t8":1875.84,"brindes":null,"promoDesc":null},
    {"id":37,"linha":"G3","produto":"KIT MASSAGEADOR GNATUS RELAX NEW (SOMENTE PARA COMPRA JUNTO...","origem":"Nacional","atacado":1142.75,"promoPct":0,"t15":1876.23,"t13":1688.61,"t11":1604.18,"t8":1540.01,"brindes":null,"promoDesc":null},
    {"id":38,"linha":"G3","produto":"KIT PEDAL JOYSTICK 5 TECLAS","origem":"Nacional","atacado":1982.06,"promoPct":0,"t15":3120.54,"t13":2808.49,"t11":2668.06,"t8":2561.34,"brindes":null,"promoDesc":null},
    {"id":39,"linha":"G3","produto":"SOFT CONFORT CABEÇA","origem":"Nacional","atacado":203.54,"promoPct":0,"t15":334.19,"t13":300.77,"t11":285.73,"t8":274.3,"brindes":null,"promoDesc":null},
    {"id":40,"linha":"G3","produto":"KIT AQUECEDOR AGUA SERINGA UA/ EQ PADRÃO","origem":"Nacional","atacado":1267.24,"promoPct":0,"t15":1995.13,"t13":1795.62,"t11":1705.84,"t8":1637.6,"brindes":null,"promoDesc":null},
    {"id":41,"linha":"G3","produto":"KIT TERM BORDEN P/ EQ F (TODOS MODELOS)","origem":"Nacional","atacado":744.27,"promoPct":0.02,"t15":1171.76,"t13":1054.58,"t11":1001.85,"t8":961.78,"brindes":null,"promoDesc":null},
    {"id":42,"linha":"G3","produto":"KIT TERMINAL BORDEN EQUIPO H","origem":"Nacional","atacado":856.71,"promoPct":0,"t15":1330.57,"t13":1197.51,"t11":1137.64,"t8":1092.13,"brindes":null,"promoDesc":null},
    {"id":43,"linha":"G3","produto":"KIT ULTRASSOM F (ACOMPANHA 5 INSERTOS)","origem":"Importado","atacado":2173.29,"promoPct":0.1,"t15":3784.49,"t13":3406.04,"t11":3235.74,"t8":3106.31,"brindes":null,"promoDesc":"10% DE DESCONTO ADICIONAL"},
    {"id":44,"linha":"G3","produto":"KIT ULTRASSOM H (ACOMPANHA 5 INSERTOS)","origem":"Importado","atacado":2281.83,"promoPct":0,"t15":3914.19,"t13":3522.77,"t11":3346.64,"t8":3212.77,"brindes":null,"promoDesc":null},
    {"id":45,"linha":"G3","produto":"KIT MICROMOTOR ELETRICO ELITE 100 (DE EMBUTIR, SEM PAINEL,...","origem":"Importado","atacado":6127.98,"promoPct":0.2,"t15":10061.29,"t13":9055.16,"t11":8602.41,"t8":8258.31,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL"},
    {"id":46,"linha":"G3","produto":"KIT MICROMOTOR ELETRICO ELITE 100 (DE EMBUTIR, SEM PAINEL,... #2","origem":"Importado","atacado":6339.39,"promoPct":0,"t15":10408.39,"t13":9367.55,"t11":8899.18,"t8":8543.21,"brindes":null,"promoDesc":null},
    {"id":47,"linha":"G3","produto":"KIT MICROMOTOR ELÉTRICO ELITE 200 - EQUIPO F (EMBUTIR COM...","origem":"Importado","atacado":7052.17,"promoPct":0,"t15":11580.29,"t13":10422.26,"t11":9901.15,"t8":9505.1,"brindes":null,"promoDesc":null},
    {"id":48,"linha":"G3","produto":"KIT MICROMOTOR ELÉT. ELITE 200 - EQUIPO H (EMBUTIR COM...","origem":"Importado","atacado":7338.78,"promoPct":0,"t15":12050.94,"t13":10845.84,"t11":10303.55,"t8":9891.41,"brindes":null,"promoDesc":null},
    {"id":49,"linha":"G3","produto":"MM ELETRICO COM  CONSOLE PORTÁTIL SEM CONTRA ÂNGULO MULTIPLICADOR","origem":"Importado","atacado":7362.44,"promoPct":0.2,"t15":12088.1,"t13":10879.29,"t11":10335.33,"t8":9921.91,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL"},
    {"id":50,"linha":"G3","produto":"PECA DE MAO CONTRA ANGULAR M5 PB","origem":"Importado","atacado":2588.25,"promoPct":0.4,"t15":4249.54,"t13":3824.59,"t11":3633.36,"t8":3488.02,"brindes":null,"promoDesc":"40% DE DESCONTO ADICIONAL"},
    {"id":51,"linha":"G3","produto":"JATO DE BICARBONATO JET HAND TB","origem":"Importado","atacado":300.29,"promoPct":0,"t15":513.58,"t13":462.22,"t11":439.11,"t8":421.55,"brindes":null,"promoDesc":null},
    {"id":52,"linha":"G3","produto":"KIT TERMINAL JATO DE BICARBONATO EQ. F (KIT COMPLETO COM PEÇA...","origem":"Nacional","atacado":1328.44,"promoPct":0,"t15":2181.12,"t13":1963.01,"t11":1864.86,"t8":1790.26,"brindes":null,"promoDesc":null},
    {"id":53,"linha":"G3","produto":"KIT TERMINAL JATO DE BICARBONATO EQ. H ( KIT COMPLETO COM...","origem":"Nacional","atacado":1328.44,"promoPct":0,"t15":2181.12,"t13":1963.01,"t11":1864.86,"t8":1790.26,"brindes":null,"promoDesc":null},
    {"id":54,"linha":"G3","produto":"KIT TERMINAL SERINGA TRÍPLICE UA G2/G3","origem":"Nacional","atacado":993.1,"promoPct":0,"t15":1563.52,"t13":1407.17,"t11":1336.81,"t8":1283.34,"brindes":null,"promoDesc":null},
    {"id":55,"linha":"G3","produto":"KIT TERMINAL SUCTOR VENTURI UA G3/G4/G8","origem":"Nacional","atacado":692.19,"promoPct":0,"t15":1089.78,"t13":980.8,"t11":931.76,"t8":894.49,"brindes":null,"promoDesc":null},
    {"id":56,"linha":"G3","produto":"KIT TERMINAL SUCTOR BV UA G3/G4","origem":"Nacional","atacado":650.48,"promoPct":0,"t15":1024.11,"t13":921.7,"t11":875.61,"t8":840.59,"brindes":null,"promoDesc":null},
    {"id":57,"linha":"G3","produto":"KIT TTERMINAL SUCTOR VAC PLUS UA G3/G4","origem":"Nacional","atacado":1080.99,"promoPct":0,"t15":1774.83,"t13":1597.35,"t11":1517.48,"t8":1456.78,"brindes":null,"promoDesc":null},
    {"id":58,"linha":"G3","produto":"KIT ALCANCE UA G3 C/ PAD - LINHA S","origem":"Nacional","atacado":1886.89,"promoPct":0,"t15":2970.7,"t13":2673.63,"t11":2539.95,"t8":2438.35,"brindes":null,"promoDesc":null},
    {"id":59,"linha":"G3","produto":"UPGRADE - REFLETOR ODONTOLÓGICO HELIOS LED-V3","origem":"Importado","atacado":1326.1,"promoPct":0,"t15":2146.47,"t13":1931.82,"t11":1835.23,"t8":1761.82,"brindes":null,"promoDesc":null},
    {"id":60,"linha":"G3","produto":"CAMERA DIGITAL INTRAORAL E CORPORAL TIMEX 1H","origem":"Importado","atacado":5546.96,"promoPct":0.15,"t15":8388.33,"t13":7549.5,"t11":7172.02,"t8":6885.14,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":61,"linha":"G3","produto":"CAMERA DIGITAL INTRAORAL E CORPORAL TIMEX 2H","origem":"Importado","atacado":4038.78,"promoPct":0,"t15":6107.61,"t13":5496.85,"t11":5222.01,"t8":5013.13,"brindes":null,"promoDesc":null},
    {"id":62,"linha":"G3","produto":"SUPORTE MONITOR P/ CONSULTÓRIO ORIGINAL GNATUS (G1, G2, G3 E G4)","origem":"Importado","atacado":1500.52,"promoPct":0,"t15":2463.63,"t13":2217.27,"t11":2106.4,"t8":2022.15,"brindes":null,"promoDesc":null},
    {"id":63,"linha":"G3","produto":"ALL IN ONE 21,5 POL PROCESSADOR I3-3120M 8GB RAM 128 GB SSD...","origem":"Importado","atacado":4424.28,"promoPct":0.15,"t15":7062.28,"t13":6356.05,"t11":6038.25,"t8":5796.72,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":64,"linha":"G3","produto":"CART G-TOTEM (SEM MONITOR)","origem":"Importado","atacado":3800.16,"promoPct":0.15,"t15":5898.27,"t13":5308.44,"t11":5043.02,"t8":4841.3,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL NA COMPRA DO KIT MULTIMIDIA DENTRO DA TABELA"},
    {"id":65,"linha":"G3","produto":"SENSOR RADIOLOGICO DIGITAL TIMEX 1H","origem":"Importado","atacado":8438.06,"promoPct":0.2,"t15":14900.35,"t13":13410.32,"t11":12739.8,"t8":12230.21,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL + POSICIONADOR"},
    {"id":66,"linha":"G3","produto":"SENSOR RADIOLOGICO DIGITAL TIMEX 2H","origem":"Importado","atacado":9647.85,"promoPct":0,"t15":17356.96,"t13":15621.26,"t11":14840.2,"t8":14246.59,"brindes":null,"promoDesc":null},
    {"id":67,"linha":"G3","produto":"POSICIONADOR RADIOGRAFICO CONE INDICATOR TIMEX DIGITAL 1 (4...","origem":"Importado","atacado":190.66,"promoPct":0,"t15":313.04,"t13":281.74,"t11":267.65,"t8":256.94,"brindes":null,"promoDesc":null},
    {"id":68,"linha":"G3","produto":"POSICIONADOR RADIOGRAFICO CONE INDICATOR TIMEX DIGITAL 2 (4...","origem":"Importado","atacado":190.66,"promoPct":0,"t15":313.04,"t13":281.74,"t11":267.65,"t8":256.94,"brindes":null,"promoDesc":null},
    {"id":69,"linha":"G3","produto":"KIT BANDEJA AUXILIAR PLASTICA","origem":"Nacional","atacado":342.83,"promoPct":0,"t15":562.87,"t13":506.58,"t11":481.25,"t8":462,"brindes":null,"promoDesc":null},
    {"id":70,"linha":"G2","produto":"CONS GNATUS G2 H - CAIXA COMANDO INTEGRADA - ESTRUTURA COR...","origem":"Nacional","atacado":29282.95,"promoPct":0,"t15":45798.7,"t13":41218.83,"t11":39157.89,"t8":37591.57,"brindes":"Fotopolimerizador O-Light II","promoDesc":"GANHE FOTOPOLIMERIZADOR O-LIGHT II (CÓDIGO 9811)"},
    {"id":71,"linha":"G2","produto":"CONS GNATUS G2 F - CAIXA COMANDO INTEGRADA - ESTRUTURA COR...","origem":"Nacional","atacado":27263.37,"promoPct":0,"t15":42640.06,"t13":38376.05,"t11":36457.25,"t8":34998.96,"brindes":"Fotopolimerizador O-Light II","promoDesc":"GANHE FOTOPOLIMERIZADOR O-LIGHT II (CÓDIGO 9811)"},
    {"id":72,"linha":"G2","produto":"CONS GNATUS G2 C - CAIXA COMANDO INTEGRADA - ESTRUTURA COR...","origem":"Nacional","atacado":25445.74,"promoPct":0,"t15":39797.28,"t13":35817.55,"t11":34026.68,"t8":32665.61,"brindes":"Fotopolimerizador O-Light II","promoDesc":"GANHE FOTOPOLIMERIZADOR O-LIGHT II (CÓDIGO 9811)"},
    {"id":73,"linha":"G2","produto":"UPGRADE PARA ESTOFAMENTO COURO (CADEIRA + MOCHO)","origem":"Nacional","atacado":3064.78,"promoPct":0,"t15":4961.09,"t13":4464.98,"t11":4241.73,"t8":4072.06,"brindes":null,"promoDesc":null},
    {"id":74,"linha":"G2","produto":"KIT CAIXA DE LIGAÇÃO PADRÃO","origem":"Nacional","atacado":1411.73,"promoPct":0,"t15":2285.38,"t13":2056.84,"t11":1954,"t8":1875.84,"brindes":null,"promoDesc":null},
    {"id":75,"linha":"G2","produto":"KIT MASSAGEADOR GNATUS RELAX NEW (SOMENTE PARA COMPRA JUNTO...","origem":"Nacional","atacado":1142.75,"promoPct":0,"t15":1876.23,"t13":1688.61,"t11":1604.18,"t8":1540.01,"brindes":null,"promoDesc":null},
    {"id":76,"linha":"G2","produto":"KIT PEDAL JOYSTICK 5 TECLAS","origem":"Nacional","atacado":1982.06,"promoPct":0,"t15":3120.54,"t13":2808.49,"t11":2668.06,"t8":2561.34,"brindes":null,"promoDesc":null},
    {"id":77,"linha":"G2","produto":"KIT PEDAL JOYSTICK 3 TECLAS","origem":"Nacional","atacado":947.95,"promoPct":0,"t15":1492.45,"t13":1343.21,"t11":1276.04,"t8":1225,"brindes":null,"promoDesc":null},
    {"id":78,"linha":"G2","produto":"SOFT CONFORT CABEÇA","origem":"Nacional","atacado":203.54,"promoPct":0,"t15":334.19,"t13":300.77,"t11":285.73,"t8":274.3,"brindes":null,"promoDesc":null},
    {"id":79,"linha":"G2","produto":"KIT AQUECEDOR AGUA SERINGA UA/ EQ PADRÃO","origem":"Nacional","atacado":1267.24,"promoPct":0,"t15":1995.13,"t13":1795.62,"t11":1705.84,"t8":1637.6,"brindes":null,"promoDesc":null},
    {"id":80,"linha":"G2","produto":"KIT CONTROLE PAD C/ NEGAT EQ G3 H","origem":"Nacional","atacado":1622.88,"promoPct":0,"t15":2664.55,"t13":2398.1,"t11":2278.19,"t8":2187.06,"brindes":null,"promoDesc":null},
    {"id":81,"linha":"G2","produto":"KIT SISTEMA FLUSH EQUIPO PADRÃO (BIO SYSTEM)","origem":"Nacional","atacado":949.33,"promoPct":0,"t15":1494.63,"t13":1345.17,"t11":1277.91,"t8":1226.79,"brindes":null,"promoDesc":null},
    {"id":82,"linha":"G2","produto":"KIT TERM BORDEN P/ EQ F (TODOS MODELOS)","origem":"Nacional","atacado":744.27,"promoPct":0,"t15":1171.76,"t13":1054.58,"t11":1001.85,"t8":961.78,"brindes":null,"promoDesc":null},
    {"id":83,"linha":"G2","produto":"KIT TERMINAL BORDEN H","origem":"Nacional","atacado":856.71,"promoPct":0,"t15":1330.57,"t13":1197.51,"t11":1137.64,"t8":1092.13,"brindes":null,"promoDesc":null},
    {"id":84,"linha":"G2","produto":"KIT ULTRASSOM F (ACOMPANHA 5 INSERTOS)","origem":"Importado","atacado":2173.29,"promoPct":0.1,"t15":3784.49,"t13":3406.04,"t11":3235.74,"t8":3106.31,"brindes":null,"promoDesc":"10% DE DESCONTO ADICIONAL"},
    {"id":85,"linha":"G2","produto":"KIT ULTRASSOM H (ACOMPANHA 5 INSERTOS)","origem":"Importado","atacado":2281.83,"promoPct":0,"t15":3914.19,"t13":3522.77,"t11":3346.64,"t8":3212.77,"brindes":null,"promoDesc":null},
    {"id":86,"linha":"G2","produto":"KIT MICROMOTOR ELETRICO ELITE 100 (DE EMBUTIR, SEM PAINEL,...","origem":"Importado","atacado":6127.98,"promoPct":0.2,"t15":10061.29,"t13":9055.16,"t11":8602.41,"t8":8258.31,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL"},
    {"id":87,"linha":"G2","produto":"KIT MICROMOTOR ELETRICO ELITE 100 (DE EMBUTIR, SEM PAINEL,... #2","origem":"Importado","atacado":6339.39,"promoPct":0,"t15":10408.39,"t13":9367.55,"t11":8899.18,"t8":8543.21,"brindes":null,"promoDesc":null},
    {"id":88,"linha":"G2","produto":"KIT MICROMOTOR ELÉT. ELITE 200 - EQUIPO H (EMBUTIR COM...","origem":"Importado","atacado":7338.78,"promoPct":0,"t15":12050.94,"t13":10845.85,"t11":10303.55,"t8":9891.41,"brindes":null,"promoDesc":null},
    {"id":89,"linha":"G2","produto":"MM ELETRICO COM  CONSOLE PORTÁTIL SEM CONTRA ÂNGULO MULTIPLICADOR","origem":"Importado","atacado":7362.44,"promoPct":0.2,"t15":12088.1,"t13":10879.29,"t11":10335.32,"t8":9921.91,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL"},
    {"id":90,"linha":"G2","produto":"PECA DE MAO CONTRA ANGULAR M5 PB","origem":"Importado","atacado":2588.25,"promoPct":0.4,"t15":4249.54,"t13":3824.58,"t11":3633.35,"t8":3488.02,"brindes":null,"promoDesc":"40% DE DESCONTO ADICIONAL"},
    {"id":91,"linha":"G2","produto":"JATO DE BICARBONATO JET HAND TB","origem":"Importado","atacado":300.29,"promoPct":0,"t15":513.58,"t13":462.22,"t11":439.11,"t8":421.55,"brindes":null,"promoDesc":null},
    {"id":92,"linha":"G2","produto":"KIT TERMINAL JATO DE BICARBONATO EQ. F (KIT COMPLETO COM PEÇA...","origem":"Nacional","atacado":1328.44,"promoPct":0,"t15":2181.12,"t13":1963.01,"t11":1864.86,"t8":1790.26,"brindes":null,"promoDesc":null},
    {"id":93,"linha":"G2","produto":"KIT TERMINAL JATO DE BICARBONATO EQ. H ( KIT COMPLETO COM...","origem":"Nacional","atacado":1328.44,"promoPct":0,"t15":2181.12,"t13":1963.01,"t11":1864.86,"t8":1790.26,"brindes":null,"promoDesc":null},
    {"id":94,"linha":"G2","produto":"KIT TERMINAL SUCTOR BV UA","origem":"Nacional","atacado":614.73,"promoPct":0,"t15":967.82,"t13":871.04,"t11":827.49,"t8":794.39,"brindes":null,"promoDesc":null},
    {"id":95,"linha":"G2","produto":"KIT TTERMINAL SUCTOR VAC PLUS UA G2","origem":"Nacional","atacado":1080.99,"promoPct":0,"t15":1774.83,"t13":1597.35,"t11":1517.48,"t8":1456.78,"brindes":null,"promoDesc":null},
    {"id":96,"linha":"G2","produto":"KIT TERMINAL SERINGA TRIPLICE UA G2/G3","origem":"Nacional","atacado":993.1,"promoPct":0,"t15":1563.52,"t13":1407.17,"t11":1336.81,"t8":1283.34,"brindes":null,"promoDesc":null},
    {"id":97,"linha":"G2","produto":"KIT TERMINAL SUCTOR VENTURI UA","origem":"Nacional","atacado":581.03,"promoPct":0,"t15":914.77,"t13":823.29,"t11":782.13,"t8":750.84,"brindes":null,"promoDesc":null},
    {"id":98,"linha":"G2","produto":"KIT ALCANCE UA G2 C/ PAD - LINHA D","origem":"Nacional","atacado":1390.34,"promoPct":0,"t15":2188.94,"t13":1970.05,"t11":1871.54,"t8":1796.68,"brindes":null,"promoDesc":null},
    {"id":99,"linha":"G2","produto":"KIT PORTA-COPO C/ SENSOR PROXIMIDADE - S","origem":"Importado","atacado":673.81,"promoPct":0,"t15":1106.29,"t13":995.66,"t11":945.88,"t8":908.04,"brindes":null,"promoDesc":null},
    {"id":100,"linha":"G2","produto":"UPGRADE - REFLETOR ODONTOLÓGICO HELIOS LED FSE","origem":"Importado","atacado":904.83,"promoPct":0,"t15":1464.58,"t13":1318.12,"t11":1252.22,"t8":1202.13,"brindes":null,"promoDesc":null},
    {"id":101,"linha":"G2","produto":"CAMERA DIGITAL INTRAORAL E CORPORAL TIMEX 1H","origem":"Importado","atacado":5546.96,"promoPct":0.15,"t15":8388.33,"t13":7549.5,"t11":7172.02,"t8":6885.14,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":102,"linha":"G2","produto":"CAMERA DIGITAL INTRAORAL E CORPORAL TIMEX 2H","origem":"Importado","atacado":4038.78,"promoPct":0,"t15":6107.61,"t13":5496.85,"t11":5222.01,"t8":5013.13,"brindes":null,"promoDesc":null},
    {"id":103,"linha":"G2","produto":"SUPORTE MONITOR P/ CONSULTÓRIO ORIGINAL GNATUS (G1, G2, G3 E G4)","origem":"Importado","atacado":1500.52,"promoPct":0,"t15":2463.63,"t13":2217.27,"t11":2106.4,"t8":2022.15,"brindes":null,"promoDesc":null},
    {"id":104,"linha":"G2","produto":"ALL IN ONE 21,5 POL PROCESSADOR I3-3120M 8GB RAM 128 GB SSD...","origem":"Importado","atacado":4424.28,"promoPct":0.15,"t15":7062.28,"t13":6356.05,"t11":6038.25,"t8":5796.72,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":105,"linha":"G2","produto":"CART G-TOTEM (SEM MONITOR)","origem":"Importado","atacado":3800.16,"promoPct":0.15,"t15":5898.27,"t13":5308.44,"t11":5043.02,"t8":4841.3,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL NA COMPRA DO KIT MULTIMIDIA DENTRO DA TABELA"},
    {"id":106,"linha":"G2","produto":"SENSOR RADIOLOGICO DIGITAL TIMEX 1H","origem":"Importado","atacado":8438.06,"promoPct":0.2,"t15":14900.35,"t13":13410.32,"t11":12739.8,"t8":12230.21,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL + POSICIONADOR"},
    {"id":107,"linha":"G2","produto":"SENSOR RADIOLOGICO DIGITAL TIMEX 2H","origem":"Importado","atacado":9647.85,"promoPct":0,"t15":17356.96,"t13":15621.26,"t11":14840.2,"t8":14246.59,"brindes":null,"promoDesc":null},
    {"id":108,"linha":"G2","produto":"POSICIONADOR RADIOGRAFICO CONE INDICATOR TIMEX DIGITAL 1 (4...","origem":"Importado","atacado":190.66,"promoPct":0,"t15":313.04,"t13":281.74,"t11":267.65,"t8":256.94,"brindes":null,"promoDesc":null},
    {"id":109,"linha":"G2","produto":"POSICIONADOR RADIOGRAFICO CONE INDICATOR TIMEX DIGITAL 2 (4...","origem":"Importado","atacado":190.66,"promoPct":0,"t15":313.04,"t13":281.74,"t11":267.65,"t8":256.94,"brindes":null,"promoDesc":null},
    {"id":110,"linha":"G2","produto":"KIT BANDEJA AUXILIAR PLASTICA","origem":"Nacional","atacado":342.83,"promoPct":0,"t15":562.87,"t13":506.58,"t11":481.25,"t8":462,"brindes":null,"promoDesc":null},
    {"id":111,"linha":"G1","produto":"CONSULTORIO G1 FIT SF","origem":"Nacional","atacado":18402.84,"promoPct":0,"t15":29175.11,"t13":26257.6,"t11":24944.72,"t8":23946.93,"brindes":"Kit Terminal Suctor BV UA","promoDesc":"GANHE KIT BV"},
    {"id":112,"linha":"G1","produto":"CONSULTORIO G1 FIT C","origem":"Nacional","atacado":18402.84,"promoPct":0,"t15":29175.11,"t13":26257.6,"t11":24944.72,"t8":23946.93,"brindes":"Kit Terminal Suctor BV UA","promoDesc":"GANHE KIT BV"},
    {"id":113,"linha":"G1","produto":"CONSULTORIO G1 F","origem":"Nacional","atacado":20895.41,"promoPct":0,"t15":32809.42,"t13":29528.48,"t11":28052.05,"t8":26929.97,"brindes":"Kit Terminal Suctor BV UA; Kit Porta-Copo c/ Sensor","promoDesc":"GANHE KIT BV + KIT SENSOR E PORTA COPO"},
    {"id":114,"linha":"G1","produto":"CONSULTORIO G1 SF","origem":"Nacional","atacado":19409.88,"promoPct":0,"t15":30476.89,"t13":27429.2,"t11":26057.74,"t8":25015.43,"brindes":"Kit Terminal Suctor BV UA","promoDesc":"GANHE KIT BV"},
    {"id":115,"linha":"G1","produto":"UPGRADE PARA ESTOFAMENTO COURO (CADEIRA + MOCHO)","origem":"Nacional","atacado":3000.26,"promoPct":0,"t15":4777.43,"t13":4299.69,"t11":4084.7,"t8":3921.31,"brindes":null,"promoDesc":null},
    {"id":116,"linha":"G1","produto":"KIT CAIXA DE LIGACAO PADRÃO","origem":"Nacional","atacado":1411.83,"promoPct":0,"t15":2285.39,"t13":2056.85,"t11":1954.01,"t8":1875.85,"brindes":null,"promoDesc":null},
    {"id":117,"linha":"G1","produto":"SOFT COMFORT CABEÇA","origem":"Nacional","atacado":203.54,"promoPct":0,"t15":334.19,"t13":300.77,"t11":285.73,"t8":274.3,"brindes":null,"promoDesc":null},
    {"id":118,"linha":"G1","produto":"KIT MECANISMO ENC CABECA ALAVANCA S","origem":"Nacional","atacado":791.32,"promoPct":0,"t15":1299.23,"t13":1169.31,"t11":1110.84,"t8":1066.41,"brindes":null,"promoDesc":null},
    {"id":119,"linha":"G1","produto":"KIT BRACOS LUXO (FIX/REB) CAD SV","origem":"Nacional","atacado":1246.35,"promoPct":0,"t15":2046.33,"t13":1841.7,"t11":1749.61,"t8":1679.63,"brindes":null,"promoDesc":null},
    {"id":120,"linha":"G1","produto":"KIT PORTA-COPO C/ SENSOR PROXIMIDADE - S 16000002818 +...","origem":"Importado","atacado":715.05,"promoPct":0,"t15":1179.67,"t13":1061.7,"t11":1008.62,"t8":968.27,"brindes":null,"promoDesc":null},
    {"id":121,"linha":"G1","produto":"CHICOTE FLAT CABLE P/ KIT ALCANCE COM PAD G2 - (2MT)","origem":"Importado","atacado":41.24,"promoPct":0,"t15":72.78,"t13":65.5,"t11":62.23,"t8":59.74,"brindes":null,"promoDesc":null},
    {"id":122,"linha":"G1","produto":"KIT NEGATOSCÓPIO EQUIPO G2 + CHICOTE KIT NEGATOSCÓPIO EQUIPO G2","origem":"Importado","atacado":236.28,"promoPct":0,"t15":393.02,"t13":353.72,"t11":336.03,"t8":322.59,"brindes":null,"promoDesc":null},
    {"id":123,"linha":"G1","produto":"CHICOTE KIT NEGATOSCÓPIO EQUIPO G2","origem":"Importado","atacado":41.24,"promoPct":0,"t15":72.78,"t13":65.5,"t11":62.23,"t8":59.74,"brindes":null,"promoDesc":null},
    {"id":124,"linha":"G1","produto":"KIT AQUECEDOR AGUA SERINGA UA/ EQ PADRÃO + KIT CHICOTE...","origem":"Nacional","atacado":1308.48,"promoPct":0,"t15":2067.91,"t13":1861.12,"t11":1768.06,"t8":1697.34,"brindes":null,"promoDesc":null},
    {"id":125,"linha":"G1","produto":"KIT SISTEMA FLUSH EQUIPO PADRÃO (BIO SYSTEM)","origem":"Nacional","atacado":949.33,"promoPct":0,"t15":1494.63,"t13":1345.17,"t11":1277.91,"t8":1226.79,"brindes":null,"promoDesc":null},
    {"id":126,"linha":"G1","produto":"KIT TERM BORDEN P/ EQ F (TODOS MODELOS)","origem":"Nacional","atacado":744.27,"promoPct":0,"t15":1171.76,"t13":1054.58,"t11":1001.85,"t8":961.78,"brindes":null,"promoDesc":null},
    {"id":127,"linha":"G1","produto":"KIT ULTRASSOM F + KIT CHICOTE ACESSORIOS G1 E G1 FIT","origem":"Importado","atacado":2214.53,"promoPct":0.1,"t15":3857.27,"t13":3471.54,"t11":3297.97,"t8":3166.05,"brindes":null,"promoDesc":"10% DE DESCONTO ADICIONAL"},
    {"id":128,"linha":"G1","produto":"JATO DE BICARBONATO JET HAND TB","origem":"Importado","atacado":300.29,"promoPct":0,"t15":513.58,"t13":462.22,"t11":439.11,"t8":421.55,"brindes":null,"promoDesc":null},
    {"id":129,"linha":"G1","produto":"KIT CHICOTE ACESSORIOS G1 E G1 FIT","origem":"Importado","atacado":41.24,"promoPct":0,"t15":72.78,"t13":65.5,"t11":62.23,"t8":59.74,"brindes":null,"promoDesc":null},
    {"id":130,"linha":"G1","produto":"KIT TERMINAL SUCTOR BV UA","origem":"Nacional","atacado":614.73,"promoPct":0,"t15":967.82,"t13":871.04,"t11":827.49,"t8":794.39,"brindes":null,"promoDesc":null},
    {"id":131,"linha":"G1","produto":"KIT TERMINAL SERINGA TRÍPLICE UA G2/G3","origem":"Nacional","atacado":993.1,"promoPct":0,"t15":1563.52,"t13":1407.17,"t11":1336.81,"t8":1283.34,"brindes":null,"promoDesc":null},
    {"id":132,"linha":"G1","produto":"KIT TERMINAL SUCTOR VENTURI UA","origem":"Nacional","atacado":581.03,"promoPct":0,"t15":914.77,"t13":823.29,"t11":782.13,"t8":750.84,"brindes":null,"promoDesc":null},
    {"id":133,"linha":"G1","produto":"KIT ALCANCE UA G2 C/ PAD - LINHA S (LINHA G1)","origem":"Nacional","atacado":1430.76,"promoPct":0,"t15":2261.72,"t13":2035.55,"t11":1933.77,"t8":1856.42,"brindes":null,"promoDesc":null},
    {"id":134,"linha":"G1","produto":"UPGRADE - REFLETOR ODONTOLÓGICO HELIOS LED FSH - PARA LINHA...","origem":"Importado","atacado":297.46,"promoPct":0,"t15":481.47,"t13":433.32,"t11":411.66,"t8":395.19,"brindes":null,"promoDesc":null},
    {"id":135,"linha":"G1","produto":"UPGRADE - REFLETOR ODONTOLÓGICO HELIOS LED FSO - PARA LINHA G1","origem":"Importado","atacado":241.13,"promoPct":0,"t15":390.3,"t13":351.27,"t11":333.71,"t8":320.36,"brindes":null,"promoDesc":null},
    {"id":136,"linha":"G1","produto":"KIT BANDEJA AUXILIAR PLASTICA","origem":"Nacional","atacado":342.83,"promoPct":0,"t15":562.87,"t13":506.58,"t11":481.25,"t8":462,"brindes":null,"promoDesc":null},
    {"id":137,"linha":"G1 HOF","produto":"CADEIRA CLINICA HOF GNATUS (6070) + ESTOFAMENTO SOFT PVC","origem":"Nacional","atacado":13436.13,"promoPct":0,"t15":21957.45,"t13":19761.7,"t11":18773.62,"t8":18022.67,"brindes":null,"promoDesc":null},
    {"id":138,"linha":"G1 HOF","produto":"CADEIRA CLINICA HOF STANDARD GNATUS (8744) + ESTOFAMENTO SOFT...","origem":"Nacional","atacado":15506.94,"promoPct":0,"t15":25357.81,"t13":22822.03,"t11":21680.93,"t8":20813.69,"brindes":null,"promoDesc":null},
    {"id":139,"linha":"G1 HOF","produto":"CADEIRA CLINICA HOF PLUS GNATUS (8745) + ESTOFAMENTO SOFT PVC...","origem":"Nacional","atacado":14726.67,"promoPct":0,"t15":24076.63,"t13":21668.97,"t11":20585.52,"t8":19762.1,"brindes":null,"promoDesc":null},
    {"id":140,"linha":"G1 HOF","produto":"PARA TROCAR O ESTOFAMENTO CADEIRA PARA COURO ADICIONAR AO...","origem":"Nacional","atacado":1892.41,"promoPct":0,"t15":3020.76,"t13":2718.68,"t11":2582.75,"t8":2479.44,"brindes":null,"promoDesc":null},
    {"id":141,"linha":"G1 HOF","produto":"KIT BRACOS LUXO (FIX/REB) CAD SV","origem":"Nacional","atacado":1246.35,"promoPct":0,"t15":2046.33,"t13":1841.7,"t11":1749.61,"t8":1679.63,"brindes":null,"promoDesc":null},
    {"id":142,"linha":"G1 HOF","produto":"REFLETOR ODONTOLÓGICO HELIOS LED FSH","origem":"Importado","atacado":987.75,"promoPct":0,"t15":1598.79,"t13":1438.91,"t11":1366.97,"t8":1312.29,"brindes":null,"promoDesc":null},
    {"id":143,"linha":"G1 HOF","produto":"KIT MASSAGEADOR GNATUS RELAX NEW (SOMENTE PARA COMPRA JUNTO...","origem":"Nacional","atacado":1142.75,"promoPct":0,"t15":1876.23,"t13":1688.61,"t11":1604.18,"t8":1540.01,"brindes":null,"promoDesc":null},
    {"id":144,"linha":"G1 HOF","produto":"MOCHO STANDARD FIT - PV CROM","origem":"Nacional","atacado":657.69,"promoPct":0,"t15":1055.39,"t13":949.85,"t11":902.36,"t8":866.26,"brindes":null,"promoDesc":null},
    {"id":145,"linha":"G1 HOF","produto":"MOCHO STANDARD - COURO","origem":"Nacional","atacado":1877.78,"promoPct":0,"t15":3011.17,"t13":2710.05,"t11":2574.55,"t8":2471.57,"brindes":null,"promoDesc":null},
    {"id":146,"linha":"GEZINHA","produto":"CONSULTORIO GEZINHA SAFARI - CAIXA DE LIGAÇÃO INCLUSA -...","origem":"Importado","atacado":43924.39,"promoPct":0,"t15":71097.32,"t13":63987.59,"t11":60788.21,"t8":58356.68,"brindes":null,"promoDesc":null},
    {"id":147,"linha":"GEZINHA","produto":"KIT ULTRASSOM F (ACOMPANHA 5 INSERTOS)","origem":"Importado","atacado":2173.29,"promoPct":0.1,"t15":3784.49,"t13":3406.04,"t11":3235.74,"t8":3106.31,"brindes":null,"promoDesc":"10% DE DESCONTO ADICIONAL"},
    {"id":148,"linha":"GEZINHA","produto":"KIT TERMINAL SUCTOR BV UA","origem":"Nacional","atacado":614.73,"promoPct":0,"t15":967.82,"t13":871.04,"t11":827.49,"t8":794.39,"brindes":null,"promoDesc":null},
    {"id":149,"linha":"Periféricos","produto":"EQUIPOMASTER 6 LITROS","origem":"Importado","atacado":12719.11,"promoPct":0.2,"t15":18320.42,"t13":16488.38,"t11":15663.96,"t8":15037.4,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL"},
    {"id":150,"linha":"Periféricos","produto":"MOTOR IMPLANTE AVANTI - COM MALETA","origem":"Importado","atacado":5059.65,"promoPct":0,"t15":6922.58,"t13":6230.32,"t11":5918.81,"t8":5682.05,"brindes":null,"promoDesc":null},
    {"id":151,"linha":"Periféricos","produto":"MOTOR IMPLANTE E ENDO AVANTI S LED - COM MALETA","origem":"Importado","atacado":6578.83,"promoPct":0,"t15":9334.65,"t13":8401.18,"t11":7981.13,"t8":7661.88,"brindes":null,"promoDesc":null},
    {"id":152,"linha":"Periféricos","produto":"MOTOR IMPLANTE AVANTI - SEM MALETA","origem":"Importado","atacado":4558.02,"promoPct":0,"t15":6236.37,"t13":5612.73,"t11":5332.1,"t8":5118.81,"brindes":null,"promoDesc":null},
    {"id":153,"linha":"Periféricos","produto":"MOTOR IMPLANTE E ENDO AVANTI S LED - SEM MALETA","origem":"Importado","atacado":6093.91,"promoPct":0,"t15":8646.6,"t13":7781.94,"t11":7392.84,"t8":7097.13,"brindes":null,"promoDesc":null},
    {"id":154,"linha":"Periféricos","produto":"MALETA DO AVANTI","origem":"Nacional","atacado":1094.81,"promoPct":0,"t15":1497.93,"t13":1348.14,"t11":1280.73,"t8":1229.5,"brindes":null,"promoDesc":null},
    {"id":155,"linha":"Periféricos","produto":"KIT MOTOR DE IMPL AVANTI F-AVT-01 + CONTRA ANGULAR X20 S","origem":"Importado","atacado":5835.27,"promoPct":0,"t15":8383.1,"t13":7544.79,"t11":7167.55,"t8":6880.85,"brindes":null,"promoDesc":null},
    {"id":156,"linha":"Periféricos","produto":"KIT MOTOR DE IMPL AVANTI F-AVT-01 SEM MALETA + CONTRA ANGULAR...","origem":"Importado","atacado":5348.91,"promoPct":0,"t15":7684.89,"t13":6916.4,"t11":6570.58,"t8":6307.76,"brindes":null,"promoDesc":null},
    {"id":157,"linha":"Periféricos","produto":"KIT MOTO DE IMPL AVANTI S LED + CONTRA ANGULAR X20 S LED","origem":"Importado","atacado":7780.68,"promoPct":0,"t15":11177.95,"t13":10060.16,"t11":9557.15,"t8":9174.86,"brindes":null,"promoDesc":null},
    {"id":158,"linha":"Periféricos","produto":"KIT MOTO DE IMPL AVANTI S LED SEM MALETA + CONTRA ANGULAR X20...","origem":"Importado","atacado":7294.32,"promoPct":0,"t15":10479.24,"t13":9431.32,"t11":8959.75,"t8":8601.36,"brindes":null,"promoDesc":null},
    {"id":159,"linha":"Periféricos","produto":"CONTRA ÂNGULO X20 S LED","origem":"Importado","atacado":2317.59,"promoPct":0,"t15":3805.17,"t13":3424.65,"t11":3253.42,"t8":3123.28,"brindes":null,"promoDesc":null},
    {"id":160,"linha":"Periféricos","produto":"CONTRA ÂNGULO X20 S","origem":"Importado","atacado":1877.57,"promoPct":0,"t15":3082.7,"t13":2774.43,"t11":2635.71,"t8":2530.28,"brindes":null,"promoDesc":null},
    {"id":161,"linha":"Periféricos","produto":"MM ELÉTRICO C/ CONSOLE PORTÁTIL ACOPLÁVEL AO CONSULTÓRIO VIA...","origem":"Importado","atacado":7362.44,"promoPct":0.2,"t15":12088.1,"t13":10879.29,"t11":10335.33,"t8":9921.91,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL"},
    {"id":162,"linha":"Periféricos","produto":"PECA DE MAO CONTRA ANGULAR M5 PB","origem":"Importado","atacado":2588.25,"promoPct":0.4,"t15":4249.54,"t13":3824.59,"t11":3633.36,"t8":3488.02,"brindes":null,"promoDesc":"40% DE DESCONTO ADICIONAL"},
    {"id":163,"linha":"Periféricos","produto":"AUTOCLAVE ODONTOLOGICA BIOMAX 17L","origem":"Importado","atacado":5211.78,"promoPct":0,"t15":7881.47,"t13":7093.32,"t11":6738.66,"t8":6469.11,"brindes":"Seladora CleanPack","promoDesc":"GANHE 01 SELADORA CLEANPACK"},
    {"id":164,"linha":"Periféricos","produto":"AUTOCLAVE ODONTOLOGICA BIOMAX 22L","origem":"Importado","atacado":6101.11,"promoPct":0,"t15":9226.34,"t13":8303.71,"t11":7888.52,"t8":7572.98,"brindes":null,"promoDesc":null},
    {"id":165,"linha":"Periféricos","produto":"LAVADORA ULTRASSONICA BIOCLEAN 2,5L C1 127V","origem":"Importado","atacado":911.83,"promoPct":0.25,"t15":1497.09,"t13":1347.38,"t11":1280.01,"t8":1228.81,"brindes":null,"promoDesc":"25% DE DESCONTO ADICIONAL"},
    {"id":166,"linha":"Periféricos","produto":"LAVADORA ULTRASSONICA BIOCLEAN 2,5L C1 220V","origem":"Importado","atacado":911.83,"promoPct":0,"t15":1497.09,"t13":1347.38,"t11":1280.01,"t8":1228.81,"brindes":null,"promoDesc":null},
    {"id":167,"linha":"Periféricos","produto":"LAVADORA ULTRASSONICA BIOCLEAN 6L C2 127V","origem":"Importado","atacado":2209.49,"promoPct":0,"t15":3627.68,"t13":3264.91,"t11":3101.67,"t8":2977.6,"brindes":null,"promoDesc":null},
    {"id":168,"linha":"Periféricos","produto":"LAVADORA ULTRASSONICA BIOCLEAN 6L C2 220V","origem":"Importado","atacado":2209.49,"promoPct":0,"t15":3627.68,"t13":3264.91,"t11":3101.67,"t8":2977.6,"brindes":null,"promoDesc":null},
    {"id":169,"linha":"Periféricos","produto":"SELADORA CLEAN PACK 127V - 60Hz GNATUS","origem":"Importado","atacado":1752.54,"promoPct":0.25,"t15":2836.9,"t13":2553.21,"t11":2425.55,"t8":2328.53,"brindes":null,"promoDesc":"25% DE DESCONTO ADICIONAL"},
    {"id":170,"linha":"Periféricos","produto":"SELADORA CLEAN PACK 220V - 60Hz GNATUS","origem":"Importado","atacado":1752.54,"promoPct":0,"t15":2836.9,"t13":2553.21,"t11":2425.55,"t8":2328.53,"brindes":null,"promoDesc":null},
    {"id":171,"linha":"Periféricos","produto":"SELADORA MANUAL CLEANPACK GNATUS  (COM SUPORTE) - LANÇAMENTO","origem":"Nacional","atacado":313.01,"promoPct":0,"t15":513.91,"t13":462.52,"t11":439.39,"t8":421.82,"brindes":null,"promoDesc":null},
    {"id":172,"linha":"Periféricos","produto":"DESTILADORA ACQUA CLEAN 127V - 60Hz","origem":"Importado","atacado":1129.11,"promoPct":0.25,"t15":1802.34,"t13":1622.11,"t11":1541,"t8":1479.36,"brindes":null,"promoDesc":"25% DE DESCONTO ADICIONAL"},
    {"id":173,"linha":"Periféricos","produto":"DESTILADORA ACQUA CLEAN 220V - 60Hz","origem":"Importado","atacado":1129.11,"promoPct":0,"t15":1802.34,"t13":1622.11,"t11":1541,"t8":1479.36,"brindes":null,"promoDesc":null},
    {"id":174,"linha":"Periféricos","produto":"BOMBA A VÁCUO BIOVAC IV 1HP GNATUS - 127/220V","origem":"Nacional","atacado":4018.39,"promoPct":0,"t15":6504.71,"t13":5854.24,"t11":5561.53,"t8":5339.07,"brindes":null,"promoDesc":null},
    {"id":175,"linha":"Periféricos","produto":"KIT BV P/ COLUNA – 1 SUGADOR","origem":"Nacional","atacado":997.58,"promoPct":0,"t15":1569.86,"t13":1412.87,"t11":1342.23,"t8":1288.54,"brindes":null,"promoDesc":null},
    {"id":176,"linha":"Periféricos","produto":"KIT CAPA ACABAMENTO BOMBA VÁCUO","origem":"Nacional","atacado":694.73,"promoPct":0,"t15":1093.79,"t13":984.41,"t11":935.19,"t8":897.78,"brindes":null,"promoDesc":null},
    {"id":177,"linha":"Periféricos","produto":"SUGMASTER 6 LITROS","origem":"Importado","atacado":4262.43,"promoPct":0,"t15":6998.32,"t13":6298.49,"t11":5983.56,"t8":5744.22,"brindes":null,"promoDesc":null},
    {"id":178,"linha":"Periféricos","produto":"SUGMASTER 3 LITROS","origem":"Importado","atacado":3745.77,"promoPct":0.15,"t15":6150.04,"t13":5535.04,"t11":5258.28,"t8":5047.95,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":179,"linha":"Periféricos","produto":"MANGUEIRA DE SUCÇÃO DUPLA","origem":"Importado","atacado":304.43,"promoPct":0,"t15":555.37,"t13":499.83,"t11":474.84,"t8":455.85,"brindes":null,"promoDesc":null},
    {"id":180,"linha":"Periféricos","produto":"MANGUEIRA DE SUCÇÃO","origem":"Importado","atacado":199.73,"promoPct":0,"t15":370.25,"t13":333.23,"t11":316.56,"t8":303.9,"brindes":null,"promoDesc":null},
    {"id":181,"linha":"Periféricos","produto":"MANGUEIRA DE SUCÇÃO DUPLA AUTOCLAVÁVEL","origem":"Importado","atacado":405.9,"promoPct":0,"t15":740.5,"t13":666.45,"t11":633.13,"t8":607.8,"brindes":null,"promoDesc":null},
    {"id":182,"linha":"Periféricos","produto":"MANGUEIRA DE SUCÇÃO AUTOCLAVÁVEL","origem":"Importado","atacado":238.35,"promoPct":0,"t15":434.82,"t13":391.34,"t11":371.77,"t8":356.9,"brindes":null,"promoDesc":null},
    {"id":183,"linha":"Periféricos","produto":"KIT COM 4 UN. PONTEIRAS ANTI NÉVOA (ADQUIRIDOS JUNTO COM...","origem":"Importado","atacado":405.9,"promoPct":0,"t15":740.5,"t13":666.45,"t11":633.13,"t8":607.8,"brindes":null,"promoDesc":null},
    {"id":184,"linha":"Periféricos","produto":"KIT COM 4 UNIDADES PONTEIRAS ANTI NÉVOA","origem":"Importado","atacado":812.6,"promoPct":0,"t15":1482.42,"t13":1334.18,"t11":1267.47,"t8":1216.77,"brindes":null,"promoDesc":null},
    {"id":185,"linha":"Periféricos","produto":"ADAPTADOR CÂNULA BOMBA DE VÁCUO PORTÁTIL","origem":"Importado","atacado":48.81,"promoPct":0,"t15":90.41,"t13":81.37,"t11":77.3,"t8":74.21,"brindes":null,"promoDesc":null},
    {"id":186,"linha":"Periféricos","produto":"COMPRESSOR AIR CLEAN 2 - 50L 220V","origem":"Importado","atacado":3917.15,"promoPct":0,"t15":6002.66,"t13":5402.39,"t11":5132.27,"t8":4926.98,"brindes":null,"promoDesc":null},
    {"id":187,"linha":"Periféricos","produto":"COMPRESSOR AIR CLEAN 2 - 28L 220V","origem":"Importado","atacado":2344.38,"promoPct":0,"t15":3592.53,"t13":3233.28,"t11":3071.61,"t8":2948.75,"brindes":null,"promoDesc":null},
    {"id":188,"linha":"Periféricos","produto":"COMPRESSOR AIR CLEAN 150L","origem":"Importado","atacado":9127.94,"promoPct":0,"t15":14775.72,"t13":13298.15,"t11":12633.24,"t8":12127.91,"brindes":null,"promoDesc":null},
    {"id":189,"linha":"Periféricos","produto":"COMPRESSOR AIR CLEAN 250L","origem":"Importado","atacado":16344.55,"promoPct":0,"t15":23191.14,"t13":20872.03,"t11":19828.42,"t8":19035.29,"brindes":null,"promoDesc":null},
    {"id":190,"linha":"Periféricos","produto":"CAMERA DIGITAL INTRAORAL E CORPORAL TIMEX 1H","origem":"Importado","atacado":5546.96,"promoPct":0.15,"t15":8388.33,"t13":7549.5,"t11":7172.02,"t8":6885.14,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":191,"linha":"Periféricos","produto":"CAMERA DIGITAL INTRAORAL E CORPORAL TIMEX 2H","origem":"Importado","atacado":4038.78,"promoPct":0,"t15":6107.61,"t13":5496.85,"t11":5222.01,"t8":5013.13,"brindes":null,"promoDesc":null},
    {"id":192,"linha":"Periféricos","produto":"ALL IN ONE 21,5 POL PROCESSADOR I3-3120M 8GB RAM 128 GB SSD...","origem":"Importado","atacado":4424.28,"promoPct":0.15,"t15":7062.28,"t13":6356.05,"t11":6038.25,"t8":5796.72,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":193,"linha":"Periféricos","produto":"SERVIDOR DE COMPARTILHAMENTO HANDY DENTISTY","origem":"Importado","atacado":672.06,"promoPct":0,"t15":1206.88,"t13":1086.19,"t11":1031.88,"t8":990.61,"brindes":null,"promoDesc":null},
    {"id":194,"linha":"Periféricos","produto":"SUPORTE PANTOGRÁFICO UNIVERSAL (COMPATÍVEL COM MULTIMARCAS)","origem":"Nacional","atacado":1159.45,"promoPct":0.15,"t15":1959.64,"t13":1763.68,"t11":1675.49,"t8":1608.47,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL NA COMPRA DO KIT MULTIMIDIA DENTRO DA TABELA"},
    {"id":195,"linha":"Periféricos","produto":"SUPORTE MONITOR P/ CONSULTÓRIO ORIGINAL GNATUS (G1, G2, G3 E G4)","origem":"Importado","atacado":1500.52,"promoPct":0,"t15":2463.63,"t13":2217.27,"t11":2106.4,"t8":2022.15,"brindes":null,"promoDesc":null},
    {"id":196,"linha":"Periféricos","produto":"CART G-TOTEM (SEM MONITOR)","origem":"Importado","atacado":3800.16,"promoPct":0.15,"t15":5898.27,"t13":5308.44,"t11":5043.02,"t8":4841.3,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL NA COMPRA DO KIT MULTIMIDIA DENTRO DA TABELA"},
    {"id":197,"linha":"Periféricos","produto":"MONITOR TOUCH SCREEN 24 (16:9)","origem":"Importado","atacado":5250.07,"promoPct":0,"t15":8148.7,"t13":7333.83,"t11":6967.14,"t8":6688.45,"brindes":null,"promoDesc":null},
    {"id":198,"linha":"Periféricos","produto":"FONTE ADAPTADORA UNIVERSAL PARA ALL IN ONE E NOTEBOOKS -...","origem":"Importado","atacado":189.94,"promoPct":0,"t15":307.43,"t13":276.69,"t11":262.85,"t8":252.34,"brindes":null,"promoDesc":null},
    {"id":199,"linha":"Periféricos","produto":"SENSOR RADIOLOGICO DIGITAL TIMEX 1H","origem":"Importado","atacado":8438.06,"promoPct":0.2,"t15":14900.35,"t13":13410.32,"t11":12739.8,"t8":12230.21,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL + POSICIONADOR"},
    {"id":200,"linha":"Periféricos","produto":"SENSOR RADIOLOGICO DIGITAL TIMEX 2H","origem":"Importado","atacado":9647.85,"promoPct":0,"t15":17356.96,"t13":15621.26,"t11":14840.2,"t8":14246.59,"brindes":null,"promoDesc":null},
    {"id":201,"linha":"Periféricos","produto":"DIGITALIZADOR DE IMAGENS RADIOGRAFICAS TIMEX - HDS500","origem":"Importado","atacado":13297.71,"promoPct":0.15,"t15":22475.13,"t13":20227.62,"t11":19216.24,"t8":18447.59,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":202,"linha":"Periféricos","produto":"PLACA DE FOSFORO TAMANHO 0 - PARA DIGITALIZADOR TIMEX HDS500","origem":"Importado","atacado":421.06,"promoPct":0,"t15":711.66,"t13":640.49,"t11":608.47,"t8":584.13,"brindes":null,"promoDesc":null},
    {"id":203,"linha":"Periféricos","produto":"PLACA DE FOSFORO TAMANHO 1 - PARA DIGITALIZADOR TIMEX HDS500","origem":"Importado","atacado":421.06,"promoPct":0,"t15":711.66,"t13":640.49,"t11":608.47,"t8":584.13,"brindes":null,"promoDesc":null},
    {"id":204,"linha":"Periféricos","produto":"PLACA DE FOSFORO TAMANHO 2 - PARA DIGITALIZADOR TIMEX HDS500","origem":"Importado","atacado":421.06,"promoPct":0,"t15":711.66,"t13":640.49,"t11":608.47,"t8":584.13,"brindes":null,"promoDesc":null},
    {"id":205,"linha":"Periféricos","produto":"PLACA DE FOSFORO TAMANHO 3 - PARA DIGITALIZADOR TIMEX HDS500","origem":"Importado","atacado":421.06,"promoPct":0,"t15":711.66,"t13":640.49,"t11":608.47,"t8":584.13,"brindes":null,"promoDesc":null},
    {"id":206,"linha":"Periféricos","produto":"POSICIONADOR RADIOGRAFICO CONE INDICATOR TIMEX DIGITAL 1 (4...","origem":"Importado","atacado":190.66,"promoPct":0,"t15":313.04,"t13":281.74,"t11":267.65,"t8":256.94,"brindes":null,"promoDesc":null},
    {"id":207,"linha":"Periféricos","produto":"POSICIONADOR RADIOGRAFICO CONE INDICATOR TIMEX DIGITAL 2 (4...","origem":"Importado","atacado":190.66,"promoPct":0,"t15":313.04,"t13":281.74,"t11":267.65,"t8":256.94,"brindes":null,"promoDesc":null},
    {"id":208,"linha":"Periféricos","produto":"RX TIMEX 70E PANT PAREDE 127V/220V 60 HZ","origem":"Nacional","atacado":13262.12,"promoPct":0.3,"t15":21164.11,"t13":19047.7,"t11":18095.31,"t8":17371.5,"brindes":null,"promoDesc":"CAIXA DE FILME AUTO REVELAVEL + 30% DE DESCONTO NO DIGITALIZADOR"},
    {"id":209,"linha":"Periféricos","produto":"RX TIMEX 70E PAREDE 127/220V 60HZ","origem":"Nacional","atacado":11073.08,"promoPct":0,"t15":17670.77,"t13":15903.7,"t11":15108.51,"t8":14504.17,"brindes":null,"promoDesc":null},
    {"id":210,"linha":"Periféricos","produto":"RX AXR COL MOVEL 127V/220V 60HZ GNATUS","origem":"Nacional","atacado":10163.84,"promoPct":0,"t15":16451.49,"t13":14806.34,"t11":14066.02,"t8":13503.38,"brindes":null,"promoDesc":null},
    {"id":211,"linha":"Periféricos","produto":"RAIO-X PORTATIL PORT-X IV C/ PROTEÇÃO CONTRA RETROESPALHAMENTO","origem":"Importado","atacado":16374.22,"promoPct":0.15,"t15":27252.33,"t13":24527.1,"t11":23300.74,"t8":22368.71,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":212,"linha":"Periféricos","produto":"ESCUDO DE RADIAÇÃO RX PORTATIL PORT-X IV","origem":"Importado","atacado":453.38,"promoPct":0,"t15":744.38,"t13":669.94,"t11":636.44,"t8":610.99,"brindes":null,"promoDesc":null},
    {"id":213,"linha":"Periféricos","produto":"BATERIA RX PORTATIL PORT-X IV","origem":"Importado","atacado":4330.01,"promoPct":0,"t15":6132.6,"t13":5519.34,"t11":5243.37,"t8":5033.64,"brindes":null,"promoDesc":null},
    {"id":214,"linha":"Periféricos","produto":"TRIPE HS-Q999","origem":"Nacional","atacado":498.72,"promoPct":0,"t15":818.82,"t13":736.94,"t11":700.09,"t8":672.09,"brindes":null,"promoDesc":null},
    {"id":215,"linha":"Periféricos","produto":"MALETA RX PORTATIL PORT-X IV","origem":"Nacional","atacado":930.91,"promoPct":0,"t15":1273.68,"t13":1146.31,"t11":1089,"t8":1045.44,"brindes":null,"promoDesc":null},
    {"id":216,"linha":"Periféricos","produto":"JET SONIC B.P. 127/ 225V - 50/60Hz GNATUS","origem":"Nacional","atacado":4757.38,"promoPct":0,"t15":7092.51,"t13":6383.26,"t11":6064.09,"t8":5821.53,"brindes":null,"promoDesc":null},
    {"id":217,"linha":"Periféricos","produto":"ULTRASSOM EASYSONIC BIVOLT GNATUS","origem":"Importado","atacado":1679.95,"promoPct":0.5,"t15":2928.37,"t13":2635.53,"t11":2503.76,"t8":2403.61,"brindes":null,"promoDesc":"COMPRE O EASYSONIC DENTRO DA TABELA E GANHE 50% DE DESCONTO NO KIT GARRAFA"},
    {"id":218,"linha":"Periféricos","produto":"KIT IRRIGAÇÃO GARRAFA PRESSURIZADA PARA EASYSONIC","origem":"Importado","atacado":328.66,"promoPct":0,"t15":572.31,"t13":515.08,"t11":489.33,"t8":469.75,"brindes":null,"promoDesc":null},
    {"id":219,"linha":"Periféricos","produto":"JATO DE BICARBONATO JET HAND TB","origem":"Importado","atacado":300.29,"promoPct":0,"t15":513.58,"t13":462.22,"t11":439.11,"t8":421.55,"brindes":null,"promoDesc":null},
    {"id":220,"linha":"Periféricos","produto":"FOTOPOLIMERIZADOR LED D","origem":"Importado","atacado":680.89,"promoPct":0,"t15":1210.56,"t13":1089.51,"t11":1035.03,"t8":993.63,"brindes":null,"promoDesc":null},
    {"id":221,"linha":"Periféricos","produto":"FOTOPOLIMERIZADOR ODONTOLÓGICO Q-PRO - LANÇAMENTO","origem":"Importado","atacado":1614.51,"promoPct":0,"t15":2613.28,"t13":2351.95,"t11":2234.35,"t8":2144.98,"brindes":null,"promoDesc":null},
    {"id":222,"linha":"Periféricos","produto":"FOTOPOLIMERIZADOR ODONTOLÓGICO O-LIGHT II","origem":"Importado","atacado":2742.34,"promoPct":0,"t15":5178.65,"t13":4660.79,"t11":4427.75,"t8":4250.64,"brindes":null,"promoDesc":"COMPRE 03 E LEVE 06"},
    {"id":223,"linha":"Periféricos","produto":"LOCALIZADOR APICAL E TESTE DE VITALIDADE PULPAR APX1 GNATUS","origem":"Importado","atacado":1404.34,"promoPct":0.4,"t15":2096.13,"t13":1886.51,"t11":1792.19,"t8":1720.5,"brindes":null,"promoDesc":"40% DE DESCONTO ADICIONAL"},
    {"id":224,"linha":"Periféricos","produto":"LOCALIZADOR DE ÁPICE PROPEX","origem":"Importado","atacado":1041.49,"promoPct":0,"t15":1552.69,"t13":1397.42,"t11":1327.55,"t8":1274.45,"brindes":null,"promoDesc":null},
    {"id":225,"linha":"Periféricos","produto":"MICROMOTOR DE ENDODONTIA NEOENDO PRIME - LANÇAMENTO","origem":"Importado","atacado":3159.98,"promoPct":0.4,"t15":5967.3,"t13":5370.57,"t11":5102.04,"t8":4897.96,"brindes":null,"promoDesc":"40% DE DESCONTO ADICIONAL"},
    {"id":226,"linha":"Periféricos","produto":"CONTRA ANGULO OSCILATÓRIO X10 CEPB -PUSH BUTTON - PARA LIMA...","origem":"Importado","atacado":1742.65,"promoPct":0.4,"t15":2706.53,"t13":2435.88,"t11":2314.08,"t8":2221.52,"brindes":null,"promoDesc":"40% DE DESCONTO ADICIONAL"},
    {"id":227,"linha":"Conservador IOT","produto":"CÂMARA DE CONSERVACAO SAGIL - (BLACK) 21L","origem":"Importado","atacado":3403.26,"promoPct":0,"t15":5178.65,"t13":4660.78,"t11":4427.75,"t8":4250.64,"brindes":null,"promoDesc":null},
    {"id":228,"linha":"Conservador IOT","produto":"CÂMARA DE CONSERVACAO SAGIL - (BLACK) 21L #2","origem":"Importado","atacado":3403.26,"promoPct":0,"t15":5178.65,"t13":4660.78,"t11":4427.75,"t8":4250.64,"brindes":null,"promoDesc":null},
    {"id":229,"linha":"Conservador IOT","produto":"CÂMARA DE CONSERVACAO SAGIL - (WHITE)  100L  220V","origem":"Importado","atacado":7722.76,"promoPct":0,"t15":11913.88,"t13":10722.49,"t11":10186.37,"t8":9778.91,"brindes":null,"promoDesc":null},
    {"id":230,"linha":"Conservador IOT","produto":"NOBREAK UPS XPRO TS SHARA SENOIDAL UNIVERSAL - 1500VA - BIVOLT","origem":"Importado","atacado":2158.88,"promoPct":0,"t15":3398.93,"t13":3059.04,"t11":2906.09,"t8":2789.84,"brindes":null,"promoDesc":null},
    {"id":231,"linha":"Conservador IOT","produto":"NOBREAK UPS XPRO TS SHARA SENOIDAL UNIVERSAL - 1500VA - BIVOLT #2","origem":"Importado","atacado":2158.88,"promoPct":0,"t15":3398.93,"t13":3059.04,"t11":2906.09,"t8":2789.84,"brindes":null,"promoDesc":null},
    {"id":232,"linha":"Conservador IOT","produto":"RACK 2BA C/CABOS S/BATERIAS GRAFITE + BAT","origem":"Importado","atacado":591.73,"promoPct":0,"t15":951.64,"t13":856.48,"t11":813.66,"t8":781.11,"brindes":null,"promoDesc":null},
    {"id":233,"linha":"Conservador IOT","produto":"BATERIA 45A/H (12TE45) - 2 UNIDADES","origem":"Importado","atacado":1386.63,"promoPct":0,"t15":2230.04,"t13":2007.04,"t11":1906.69,"t8":1830.42,"brindes":null,"promoDesc":null},
    {"id":234,"linha":"Peças de Mão","produto":"ALTA ROTAÇÃO AX1 LED","origem":"Importado","atacado":978.95,"promoPct":0.15,"t15":1607.3,"t13":1446.57,"t11":1374.24,"t8":1319.27,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":235,"linha":"Peças de Mão","produto":"ALTA ROTAÇÃO AX1 LED UV","origem":"Importado","atacado":1148.65,"promoPct":0,"t15":1885.92,"t13":1697.33,"t11":1612.46,"t8":1547.96,"brindes":null,"promoDesc":null},
    {"id":236,"linha":"Peças de Mão","produto":"ALTA ROTAÇÃO AX1 NT","origem":"Importado","atacado":690.15,"promoPct":0,"t15":1133.14,"t13":1019.83,"t11":968.83,"t8":930.08,"brindes":null,"promoDesc":null},
    {"id":237,"linha":"Peças de Mão","produto":"ALTA ROTAÇÃO AX4 NU 45 GRAUS","origem":"Importado","atacado":742.16,"promoPct":0,"t15":1218.52,"t13":1096.67,"t11":1041.83,"t8":1000.16,"brindes":null,"promoDesc":"UPGRADE PARA AX4 LED"},
    {"id":238,"linha":"Peças de Mão","produto":"MICRO MOTOR IX1 S/ SPRAY","origem":"Importado","atacado":556.81,"promoPct":0.15,"t15":864.79,"t13":778.31,"t11":739.4,"t8":709.82,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":239,"linha":"Peças de Mão","produto":"PECA DE MAO CONTRA ANGULAR M5 PB","origem":"Importado","atacado":2588.25,"promoPct":0.4,"t15":4249.54,"t13":3824.59,"t11":3633.36,"t8":3488.02,"brindes":null,"promoDesc":"40% DE DESCONTO ADICIONAL"},
    {"id":240,"linha":"Peças de Mão","produto":"CONTRA ANGULO X1 PB","origem":"Importado","atacado":612.14,"promoPct":0.15,"t15":1005.04,"t13":904.54,"t11":859.31,"t8":824.94,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":241,"linha":"Peças de Mão","produto":"CONTRA ANGULO X1 LT  - CHAVETA","origem":"Importado","atacado":602.89,"promoPct":0,"t15":936.35,"t13":842.72,"t11":800.58,"t8":768.56,"brindes":null,"promoDesc":null},
    {"id":242,"linha":"Peças de Mão","produto":"CONTRA ANGULO OSCILATÓRIO X10 CEPB -PUSH BUTTON - PARA LIMA...","origem":"Importado","atacado":1742.65,"promoPct":0.4,"t15":2706.53,"t13":2435.88,"t11":2314.08,"t8":2221.52,"brindes":null,"promoDesc":"40% DE DESCONTO ADICIONAL"},
    {"id":243,"linha":"Peças de Mão","produto":"CONTRA ÂNGULO ROTÁTORIO X10 PB - PUSH BUTTON - PARA LIMA TIPO...","origem":"Importado","atacado":739.46,"promoPct":0,"t15":1304.57,"t13":1174.12,"t11":1115.41,"t8":1070.79,"brindes":null,"promoDesc":"VALOR MINIMO DE R$ 490,00 NO PIX"},
    {"id":244,"linha":"Peças de Mão","produto":"PECA RETA INTRA RX1","origem":"Importado","atacado":556.81,"promoPct":0.15,"t15":864.79,"t13":778.31,"t11":739.4,"t8":709.82,"brindes":null,"promoDesc":"15% DE DESCONTO ADICIONAL"},
    {"id":245,"linha":"Peças de Mão","produto":"KIT ACADÊMICO PRIME - ARO AX1 NT - CA X1 LT - MM IX1 - PR RX1...","origem":"Importado","atacado":1734.38,"promoPct":0,"t15":3139.36,"t13":2825.42,"t11":2684.15,"t8":2576.79,"brindes":null,"promoDesc":"COMPRE 09 E LEVE 10"},
    {"id":246,"linha":"Peças de Mão","produto":"KIT ACADEMICO PLUS - ARO AX1 NT - CA X1 PB - MM IX1 - PR RX1","origem":"Importado","atacado":1979.88,"promoPct":0,"t15":3311.78,"t13":2980.6,"t11":2831.57,"t8":2718.31,"brindes":null,"promoDesc":"COMPRE 08 E LEVE 09"},
    {"id":247,"linha":"Peças de Mão","produto":"KIT ACADEMICO PROFESSIONAL - ARO AX1 LED - CA X1 PB - MM IX1...","origem":"Importado","atacado":2076.86,"promoPct":0,"t15":3706.52,"t13":3335.87,"t11":3169.07,"t8":3042.31,"brindes":null,"promoDesc":"COMPRE 07 E LEVE 08"},
    {"id":248,"linha":"Peças de Mão","produto":"ADAPTADOR BROCA + CHAVE SACA BROCA","origem":"Nacional","atacado":80.02,"promoPct":0,"t15":131.41,"t13":118.27,"t11":112.36,"t8":107.86,"brindes":null,"promoDesc":null},
    {"id":249,"linha":"Peças de Mão","produto":"MOCHILA GNATUS KIT ACADEMICO","origem":"Nacional","atacado":90.28,"promoPct":0,"t15":138.34,"t13":124.51,"t11":118.28,"t8":113.55,"brindes":null,"promoDesc":null},
    {"id":250,"linha":"Peças de Mão","produto":"MM ELETRICO COM  CONSOLE PORTÁTIL SEM CONTRA ÂNGULO MULTIPLICADOR","origem":"Importado","atacado":7362.44,"promoPct":0.2,"t15":12088.1,"t13":10879.29,"t11":10335.33,"t8":9921.91,"brindes":null,"promoDesc":"20% DE DESCONTO ADICIONAL"},
    {"id":251,"linha":"Itens Avulsos","produto":"MOCHO STANDARD FIT - PV CROM","origem":"Nacional","atacado":657.69,"promoPct":0,"t15":1055.39,"t13":949.85,"t11":902.36,"t8":866.26,"brindes":null,"promoDesc":null},
    {"id":252,"linha":"Itens Avulsos","produto":"MOCHO STANDARD - PV CROM","origem":"Nacional","atacado":1235.11,"promoPct":0,"t15":1985.31,"t13":1786.78,"t11":1697.44,"t8":1629.54,"brindes":null,"promoDesc":null},
    {"id":253,"linha":"Itens Avulsos","produto":"MOCHO PROFESSIONAL I - PV CROM","origem":"Nacional","atacado":1383.74,"promoPct":0,"t15":2225.91,"t13":2003.32,"t11":1903.15,"t8":1827.03,"brindes":null,"promoDesc":null},
    {"id":254,"linha":"Itens Avulsos","produto":"MOCHO STANDARD - COURO","origem":"Nacional","atacado":1877.78,"promoPct":0,"t15":3011.17,"t13":2710.05,"t11":2574.55,"t8":2471.57,"brindes":null,"promoDesc":null},
    {"id":255,"linha":"Itens Avulsos","produto":"MOCHO PROFESSIONAL I - COURO","origem":"Nacional","atacado":2026.42,"promoPct":0,"t15":3251.78,"t13":2926.6,"t11":2780.27,"t8":2669.06,"brindes":null,"promoDesc":null},
    {"id":256,"linha":"Itens Avulsos","produto":"CABEÇOTE REFLETOR PERSUS LED","origem":"Nacional","atacado":1329.87,"promoPct":0,"t15":2183.47,"t13":1965.12,"t11":1866.87,"t8":1792.19,"brindes":null,"promoDesc":null},
    {"id":257,"linha":"Itens Avulsos","produto":"CAB REFL SIRIUS G8 SENSOR 3 LEDS (STD)","origem":"Nacional","atacado":2548.45,"promoPct":0,"t15":4067.97,"t13":3661.17,"t11":3478.11,"t8":3338.99,"brindes":null,"promoDesc":null},
    {"id":258,"linha":"Itens Avulsos","produto":"CAB REFL SIRIUS G8 SENSOR 5 LEDS (STD)","origem":"Nacional","atacado":3190.88,"promoPct":0,"t15":5165.18,"t13":4648.66,"t11":4416.23,"t8":4239.58,"brindes":null,"promoDesc":null},
    {"id":259,"linha":"Itens Avulsos","produto":"CAB REFL SIRIUS G8 SENS 5 (3X2) LEDS (STD)","origem":"Nacional","atacado":3771.03,"promoPct":0,"t15":6104.31,"t13":5493.88,"t11":5219.19,"t8":5010.42,"brindes":null,"promoDesc":null},
    {"id":260,"linha":"Itens Avulsos","produto":"REFLETOR ODONTOLÓGICO HELIOS LED FSA","origem":"Importado","atacado":690.29,"promoPct":0,"t15":1117.32,"t13":1005.59,"t11":955.31,"t8":917.1,"brindes":null,"promoDesc":null},
    {"id":261,"linha":"Itens Avulsos","produto":"REFLETOR ODONTOLÓGICO HELIOS LED FSH","origem":"Importado","atacado":987.75,"promoPct":0,"t15":1598.79,"t13":1438.91,"t11":1366.97,"t8":1312.29,"brindes":null,"promoDesc":null},
    {"id":262,"linha":"Itens Avulsos","produto":"REFLETOR ODONTOLÓGICO HELIOS LED FSO","origem":"Importado","atacado":1204.3,"promoPct":0,"t15":1949.32,"t13":1754.39,"t11":1666.67,"t8":1600,"brindes":null,"promoDesc":null},
    {"id":263,"linha":"Itens Avulsos","produto":"REFLETOR ODONTOLÓGICO HELIOS LED FSE","origem":"Importado","atacado":2133.71,"promoPct":0,"t15":3453.68,"t13":3108.31,"t11":2952.9,"t8":2834.78,"brindes":null,"promoDesc":null},
    {"id":264,"linha":"Itens Avulsos","produto":"REFLETOR ODONTOLÓGICO HELIOS LED-V3","origem":"Importado","atacado":3459.81,"promoPct":0,"t15":5600.15,"t13":5040.14,"t11":4788.13,"t8":4596.6,"brindes":null,"promoDesc":null},
    {"id":265,"linha":"Itens Avulsos","produto":"REFLETOR DUPLO BANCADA HELIUS LED ARTICULADO","origem":"Importado","atacado":7199.66,"promoPct":0,"t15":11653.58,"t13":10488.22,"t11":9963.81,"t8":9565.26,"brindes":null,"promoDesc":null},
    {"id":266,"linha":"Itens Avulsos","produto":"REFLETOR UNICO BANCADA HELIUS LED ARTICULADO","origem":"Importado","atacado":3599.43,"promoPct":0,"t15":5826.15,"t13":5243.53,"t11":4981.36,"t8":4782.1,"brindes":null,"promoDesc":null},
    {"id":267,"linha":"Itens Avulsos","produto":"CJ REFLETOR DUPLO BANCADA HZ PERSUS LED FIXO","origem":"Importado","atacado":3839.11,"promoPct":0,"t15":6214.64,"t13":5593.18,"t11":5313.52,"t8":5100.98,"brindes":null,"promoDesc":null},
    {"id":268,"linha":"Itens Avulsos","produto":"CJ REFLETOR UNICO BANCADA HZ PERSUS LED FIXO","origem":"Importado","atacado":2159,"promoPct":0,"t15":3495.18,"t13":3145.66,"t11":2988.38,"t8":2868.84,"brindes":null,"promoDesc":null},
    {"id":269,"linha":"Itens Avulsos","produto":"EQUIPO MINI 3 - NEW","origem":"Importado","atacado":1835.23,"promoPct":0,"t15":3013.18,"t13":2711.86,"t11":2576.27,"t8":2473.22,"brindes":null,"promoDesc":null},
    {"id":270,"linha":"Itens Avulsos","produto":"EQUIPO MINI 4 - NEW","origem":"Importado","atacado":2478.89,"promoPct":0,"t15":4070,"t13":3663,"t11":3479.85,"t8":3340.66,"brindes":null,"promoDesc":null},
    {"id":271,"linha":"Itens Avulsos","produto":"KIT BANDEJA AUXILIAR PLASTICA","origem":"Nacional","atacado":342.83,"promoPct":0,"t15":562.87,"t13":506.58,"t11":481.25,"t8":462,"brindes":null,"promoDesc":null},
    {"id":272,"linha":"Tip Ultrassom","produto":"TIP G1 (KIT ULTRASSOM N2/N3) - SCALING","origem":"Importado","atacado":72.3,"promoPct":0.1,"t15":141.46,"t13":127.32,"t11":120.95,"t8":116.11,"brindes":null,"promoDesc":"10% DE DESCONTO ADICIONAL"},
    {"id":273,"linha":"Tip Ultrassom","produto":"TIP G2 (KIT ULTRASSOM N2/N3) - SCALING","origem":"Importado","atacado":72.3,"promoPct":0,"t15":141.46,"t13":127.32,"t11":120.95,"t8":116.11,"brindes":null,"promoDesc":null},
    {"id":274,"linha":"Tip Ultrassom","produto":"TIP G4 (KIT ULTRASSOM N2/N3) - SCALING","origem":"Importado","atacado":108.45,"promoPct":0,"t15":212.2,"t13":190.98,"t11":181.43,"t8":174.17,"brindes":null,"promoDesc":null},
    {"id":275,"linha":"Tip Ultrassom","produto":"TIP G7 (KIT ULTRASSOM N2/N3) - SCALING","origem":"Importado","atacado":108.45,"promoPct":0,"t15":212.2,"t13":190.98,"t11":181.43,"t8":174.17,"brindes":null,"promoDesc":null},
    {"id":276,"linha":"Tip Ultrassom","produto":"TIP G8 (KIT ULTRASSOM N2/N3) - SCALING","origem":"Importado","atacado":108.45,"promoPct":0,"t15":212.2,"t13":190.98,"t11":181.43,"t8":174.17,"brindes":null,"promoDesc":null},
    {"id":277,"linha":"Tip Ultrassom","produto":"TIP G9 (KIT ULTRASSOM N2/N3) - SCALING","origem":"Importado","atacado":235.45,"promoPct":0,"t15":460.71,"t13":414.64,"t11":393.91,"t8":378.15,"brindes":null,"promoDesc":null},
    {"id":278,"linha":"Tip Ultrassom","produto":"TIP P1 (KIT ULTRASSOM N2/N3) - PERIO","origem":"Importado","atacado":108.45,"promoPct":0,"t15":212.2,"t13":190.98,"t11":181.43,"t8":174.17,"brindes":null,"promoDesc":null},
    {"id":279,"linha":"Tip Ultrassom","produto":"TIP P4 (KIT ULTRASSOM N2/N3) - PERIO","origem":"Importado","atacado":170,"promoPct":0,"t15":332.63,"t13":299.37,"t11":284.4,"t8":273.02,"brindes":null,"promoDesc":null},
    {"id":280,"linha":"Tip Ultrassom","produto":"ESTOJO DE TIPS KIT ULTRASSOM N2/N3 (2xG1, 1xG2, 1xP1, 1xG4)","origem":"Importado","atacado":420.59,"promoPct":0,"t15":705.41,"t13":634.86,"t11":603.12,"t8":579,"brindes":null,"promoDesc":null},
    {"id":281,"linha":"Tip Ultrassom","produto":"ADAPTADOR ROSCA JET SONIC","origem":"Importado","atacado":26.9,"promoPct":0.1,"t15":45.12,"t13":40.61,"t11":38.58,"t8":37.04,"brindes":null,"promoDesc":"10% DE DESCONTO ADICIONAL"},
    {"id":282,"linha":"Tip Ultrassom","produto":"CHAVE  ADAPTADOR INSERTO JETSONIC","origem":"Importado","atacado":25.17,"promoPct":0,"t15":42.21,"t13":37.99,"t11":36.09,"t8":34.65,"brindes":null,"promoDesc":null},
    {"id":283,"linha":"Tip Ultrassom","produto":"TIP GD1 (EASYSONIC) - SCALING","origem":"Importado","atacado":72.3,"promoPct":0,"t15":141.46,"t13":127.32,"t11":120.95,"t8":116.11,"brindes":null,"promoDesc":null},
    {"id":284,"linha":"Tip Ultrassom","produto":"TIP GD2 (EASYSONIC) - SCALING","origem":"Importado","atacado":72.3,"promoPct":0,"t15":141.46,"t13":127.32,"t11":120.95,"t8":116.11,"brindes":null,"promoDesc":null},
    {"id":285,"linha":"Tip Ultrassom","produto":"TIP GD4 (EASYSONIC) - SCALING","origem":"Importado","atacado":108.45,"promoPct":0,"t15":212.2,"t13":190.98,"t11":181.43,"t8":174.17,"brindes":null,"promoDesc":null},
    {"id":286,"linha":"Tip Ultrassom","produto":"TIP GD7 (EASYSONIC) - SCALING","origem":"Importado","atacado":108.45,"promoPct":0,"t15":212.2,"t13":190.98,"t11":181.43,"t8":174.17,"brindes":null,"promoDesc":null},
    {"id":287,"linha":"Tip Ultrassom","produto":"TIP GD8 (EASYSONIC) - SCALING","origem":"Importado","atacado":108.45,"promoPct":0,"t15":212.2,"t13":190.98,"t11":181.43,"t8":174.17,"brindes":null,"promoDesc":null},
    {"id":288,"linha":"Tip Ultrassom","produto":"TIP GD9 (EASYSONIC) - SCALING","origem":"Importado","atacado":235.45,"promoPct":0,"t15":460.71,"t13":414.64,"t11":393.91,"t8":378.15,"brindes":null,"promoDesc":null},
    {"id":289,"linha":"Tip Ultrassom","produto":"TIP PD1 (EASYSONIC) - PERIO","origem":"Importado","atacado":108.45,"promoPct":0,"t15":212.2,"t13":190.98,"t11":181.43,"t8":174.17,"brindes":null,"promoDesc":null},
    {"id":290,"linha":"Tip Ultrassom","produto":"TIP PD3 (EASYSONIC) - PERIO","origem":"Importado","atacado":236.11,"promoPct":0,"t15":461.99,"t13":415.79,"t11":395,"t8":379.2,"brindes":null,"promoDesc":null},
    {"id":291,"linha":"Tip Ultrassom","produto":"TIP PD4 (EASYSONIC) - PERIO","origem":"Importado","atacado":170,"promoPct":0,"t15":332.63,"t13":299.37,"t11":284.4,"t8":273.02,"brindes":null,"promoDesc":null},
    {"id":292,"linha":"Tip Ultrassom","produto":"TIP PD12 (EASYSONIC) - PERIO","origem":"Importado","atacado":579.17,"promoPct":0,"t15":971.37,"t13":874.23,"t11":830.52,"t8":797.3,"brindes":null,"promoDesc":null},
    {"id":293,"linha":"Tip Ultrassom","produto":"ESTOJO DE TIPS EASYSONIC (2xGD1, 1xGD2, 1xPD1, 1xGD4)","origem":"Importado","atacado":420.59,"promoPct":0,"t15":705.41,"t13":634.86,"t11":603.12,"t8":579,"brindes":null,"promoDesc":null},
    {"id":294,"linha":"Tip Ultrassom","produto":"TIP ED4 - ENDO (MODO ENDO APENAS NO JETSONIC)","origem":"Importado","atacado":198.82,"promoPct":0.1,"t15":389.02,"t13":350.12,"t11":332.61,"t8":319.31,"brindes":null,"promoDesc":"10% DE DESCONTO ADICIONAL"},
    {"id":295,"linha":"Tip Ultrassom","produto":"TIP ED5 - ENDO (MODO ENDO APENAS NO JETSONIC)","origem":"Importado","atacado":198.82,"promoPct":0,"t15":389.02,"t13":350.12,"t11":332.61,"t8":319.31,"brindes":null,"promoDesc":null},
    {"id":296,"linha":"Tip Ultrassom","produto":"TIP ED19D - ENDO (MODO ENDO APENAS NO JETSONIC)","origem":"Importado","atacado":198.82,"promoPct":0,"t15":389.02,"t13":350.12,"t11":332.61,"t8":319.31,"brindes":null,"promoDesc":null},
    {"id":297,"linha":"Tip Ultrassom","produto":"TIP ED24D - ENDO (MODO ENDO APENAS NO JETSONIC)","origem":"Importado","atacado":198.82,"promoPct":0,"t15":389.02,"t13":350.12,"t11":332.61,"t8":319.31,"brindes":null,"promoDesc":null},
    {"id":298,"linha":"Acessorios","produto":"PONTEIRA DE CLAREAMENTO","origem":"Importado","atacado":330.99,"promoPct":0,"t15":543.43,"t13":489.09,"t11":464.63,"t8":446.05,"brindes":null,"promoDesc":null},
    {"id":299,"linha":"Acessorios","produto":"PONTEIRA DE FOTOPOLIMERIZAÇÃO","origem":"Importado","atacado":237.09,"promoPct":0,"t15":389.27,"t13":350.34,"t11":332.83,"t8":319.51,"brindes":null,"promoDesc":null},
    {"id":300,"linha":"Acessorios","produto":"MANGUEIRA DE SUCÇÃO DUPLA","origem":"Importado","atacado":304.43,"promoPct":0,"t15":555.37,"t13":499.83,"t11":474.84,"t8":455.85,"brindes":null,"promoDesc":null},
    {"id":301,"linha":"Acessorios","produto":"MANGUEIRA DE SUCÇÃO","origem":"Importado","atacado":199.73,"promoPct":0,"t15":370.25,"t13":333.23,"t11":316.56,"t8":303.9,"brindes":null,"promoDesc":null},
    {"id":302,"linha":"Acessorios","produto":"MANGUEIRA DE SUCÇÃO DUPLA AUTOCLAVÁVEL","origem":"Importado","atacado":405.9,"promoPct":0,"t15":740.5,"t13":666.45,"t11":633.13,"t8":607.8,"brindes":null,"promoDesc":null},
    {"id":303,"linha":"Acessorios","produto":"MANGUEIRA DE SUCÇÃO AUTOCLAVÁVEL","origem":"Importado","atacado":238.35,"promoPct":0,"t15":434.82,"t13":391.34,"t11":371.77,"t8":356.9,"brindes":null,"promoDesc":null},
    {"id":304,"linha":"Acessorios","produto":"KIT COM 4 UN. PONTEIRAS ANTI NÉVOA (ADQUIRIDOS JUNTO COM...","origem":"Importado","atacado":405.9,"promoPct":0,"t15":740.5,"t13":666.45,"t11":633.13,"t8":607.8,"brindes":null,"promoDesc":null},
    {"id":305,"linha":"Acessorios","produto":"KIT COM 4 UNIDADES PONTEIRAS ANTI NÉVOA","origem":"Importado","atacado":812.6,"promoPct":0,"t15":1482.42,"t13":1334.18,"t11":1267.47,"t8":1216.77,"brindes":null,"promoDesc":null},
    {"id":306,"linha":"Acessorios","produto":"ADAPTADOR CÂNULA BOMBA DE VÁCUO PORTÁTIL","origem":"Importado","atacado":48.81,"promoPct":0,"t15":90.41,"t13":81.37,"t11":77.3,"t8":74.21,"brindes":null,"promoDesc":null},
    {"id":307,"linha":"Acessorios","produto":"KIT IRRIGAÇÃO","origem":"Importado","atacado":94.22,"promoPct":0,"t15":158.02,"t13":142.22,"t11":135.11,"t8":129.7,"brindes":null,"promoDesc":null},
    {"id":308,"linha":"Acessorios","produto":"POSICIONADOR RADIOGRAFICO CONE INDICATOR TIMEX DIGITAL 1 (4...","origem":"Importado","atacado":190.66,"promoPct":0,"t15":313.04,"t13":281.74,"t11":267.65,"t8":256.94,"brindes":null,"promoDesc":null},
    {"id":309,"linha":"Acessorios","produto":"POSICIONADOR RADIOGRAFICO CONE INDICATOR TIMEX DIGITAL 2 (4...","origem":"Importado","atacado":190.66,"promoPct":0,"t15":313.04,"t13":281.74,"t11":267.65,"t8":256.94,"brindes":null,"promoDesc":null},
    {"id":310,"linha":"Consumíveis","produto":"FILME AUTORREVELÁVEL PARA RAIOS X ODONTOLÓGICO (CX C/ 50)","origem":"Importado","atacado":310.96,"promoPct":0,"t15":549.82,"t13":494.84,"t11":470.1,"t8":451.29,"brindes":null,"promoDesc":"COMPRE 1 CX E GANHE A SEGUNDA CX"},
    {"id":311,"linha":"Consumíveis","produto":"GNATUS SPRAY LUBRIFICANTE ALTA/BAIXA 200ML","origem":"Nacional","atacado":35.11,"promoPct":0,"t15":56.87,"t13":51.18,"t11":48.62,"t8":46.68,"brindes":null,"promoDesc":null},
    {"id":312,"linha":"Consumíveis","produto":"KIT PLASTICO PROTETOR DIGITALIZADOR – TAMANHO 0","origem":"Importado","atacado":93.31,"promoPct":0,"t15":151.04,"t13":135.94,"t11":129.14,"t8":123.97,"brindes":null,"promoDesc":null},
    {"id":313,"linha":"Consumíveis","produto":"KIT PLASTICO PROTETOR DIGITALIZADOR – TAMANHO 1","origem":"Importado","atacado":93.31,"promoPct":0,"t15":151.04,"t13":135.94,"t11":129.14,"t8":123.97,"brindes":null,"promoDesc":null},
    {"id":314,"linha":"Consumíveis","produto":"KIT PLASTICO PROTETOR DIGITALIZADOR – TAMANHO 2","origem":"Importado","atacado":93.31,"promoPct":0,"t15":151.04,"t13":135.94,"t11":129.14,"t8":123.97,"brindes":null,"promoDesc":null},
    {"id":315,"linha":"Consumíveis","produto":"KIT PLASTICO PROTETOR DIGITALIZADOR – TAMANHO 3","origem":"Importado","atacado":93.31,"promoPct":0,"t15":151.04,"t13":135.94,"t11":129.14,"t8":123.97,"brindes":null,"promoDesc":null},
    {"id":316,"linha":"Consumíveis","produto":"KIT CAPA PAPEL PROTEÇÃO DIGITALIZADOR – TAMANHO 0","origem":"Importado","atacado":23.24,"promoPct":0,"t15":38.15,"t13":34.34,"t11":32.62,"t8":31.31,"brindes":null,"promoDesc":null},
    {"id":317,"linha":"Consumíveis","produto":"KIT CAPA PAPEL PROTEÇÃO DIGITALIZADOR – TAMANHO 1","origem":"Importado","atacado":28.38,"promoPct":0,"t15":46.59,"t13":41.93,"t11":39.83,"t8":38.24,"brindes":null,"promoDesc":null},
    {"id":318,"linha":"Consumíveis","produto":"KIT CAPA PAPEL PROTEÇÃO DIGITALIZADOR – TAMANHO 2","origem":"Importado","atacado":33.55,"promoPct":0,"t15":55.08,"t13":49.57,"t11":47.09,"t8":45.21,"brindes":null,"promoDesc":null},
    {"id":319,"linha":"Consumíveis","produto":"KIT CAPA PAPEL PROTEÇÃO DIGITALIZADOR – TAMANHO 3","origem":"Importado","atacado":46.76,"promoPct":0,"t15":76.78,"t13":69.1,"t11":65.65,"t8":63.02,"brindes":null,"promoDesc":null},
    {"id":320,"linha":"Scanner","produto":"SCANNER INTRAORAL HELIOS 500","origem":"Importado","atacado":28000,"promoPct":0,"t15":0,"t13":45259.94,"t11":0,"t8":0,"brindes":"Cart G-Totem","promoDesc":"Os 10 Primeiros ganha o Cart G-Toch"}
  ];

  // ---- Formatação pt-BR ----
  const fmtBRL = (n) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (frac, casas) => ((Number(frac) || 0) * 100).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas == null ? 2 : casas }) + '%';
  const fmtNum = (n, c) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: c == null ? 2 : c, maximumFractionDigits: c == null ? 2 : c });

  // Base comum (custo efetivo de compra + receita líquida + custo financeiro) ----
  function base(state) {
    const custoAposPromo = state.atacado * (1 - state.descontoPromo);
    const fatorCombinado = (1 - 0.07 * (state.pix ? 1 : 0)) *
      (1 - 0.05 * (state.cartao6x ? 1 : 0)) *
      (1 - 0.08 * (state.franqueado ? 1 : 0)) *
      (1 - state.descontoLivre);
    const custo = custoAposPromo * fatorCombinado;
    const receita = state.precoVendaFinal * (1 - state.descontoExtra);
    const aplicaFin = (state.tabela === 'T13' || state.tabela === 'T8') && state.cartao6x && !state.pix;
    const custoFinanceiro = aplicaFin ? (receita - custo) * 0.04 : 0;
    return { custoAposPromo, fatorCombinado, custo, receita, custoFinanceiro };
  }

  // Cálculo por regime. Retorna valores + demonstrativo (linhas) + indicadores.
  function computar(regime, state) {
    const est = ESTADOS.find((e) => e.uf === state.uf) || ESTADOS[0];
    const icmsInterno = est.interno;
    const icmsCredito = state.origem === 'Importado' ? 0.04 : est.inter;
    const fator = state.fatorDifal;
    const b = base(state);
    const { custo, receita, custoFinanceiro } = b;
    const comissao = receita * state.pctComissao;
    const frete = receita * state.pctFrete;

    const linhas = [];
    linhas.push({ label: 'Receita líquida de venda', valor: receita, kind: 'receita' });
    linhas.push({ label: '(−) Custo efetivo de compra', valor: -custo, kind: 'deducao' });

    let lucro, extra = {};

    if (regime === 'simples') {
      const difal = custo * Math.max(0, icmsInterno - icmsCredito) * fator;
      const das = receita * state.aliquotaDAS;
      linhas.push({ label: '(−) DIFAL (' + fmtPct(Math.max(0, icmsInterno - icmsCredito)) + ' × fator ' + fmtNum(fator) + ')', valor: -difal, kind: 'deducao' });
      linhas.push({ label: '(−) DAS (' + fmtPct(state.aliquotaDAS) + ')', valor: -das, kind: 'deducao' });
      linhas.push({ label: '(−) Custo financeiro do parcelamento', valor: -custoFinanceiro, kind: 'deducao' });
      linhas.push({ label: '(−) Comissão (' + fmtPct(state.pctComissao) + ')', valor: -comissao, kind: 'deducao' });
      linhas.push({ label: '(−) Frete (' + fmtPct(state.pctFrete) + ')', valor: -frete, kind: 'deducao' });
      lucro = receita - custo - difal - das - custoFinanceiro - comissao - frete;
      extra = { difal, das };
    } else if (regime === 'presumido') {
      const icmsDebito = receita * icmsInterno;
      const creditoIcms = custo * icmsCredito * fator;
      const icmsARecolher = Math.max(0, icmsDebito - creditoIcms);
      const pisCofins = receita * state.pisCofinsPresumido;
      const basePresumida = receita * state.basePresumida;
      const irpjCsll = basePresumida * state.irpjCsllBase + Math.max(0, basePresumida - 1666.67) * 0.10;
      linhas.push({ label: 'ICMS débito (saída, ' + fmtPct(icmsInterno) + ')', valor: -icmsDebito, kind: 'sub' });
      linhas.push({ label: 'ICMS crédito (entrada × fator, ' + fmtPct(icmsCredito) + ')', valor: creditoIcms, kind: 'sub' });
      linhas.push({ label: '(−) ICMS a recolher', valor: -icmsARecolher, kind: 'deducao' });
      linhas.push({ label: '(−) PIS+COFINS cumulativo (' + fmtPct(state.pisCofinsPresumido) + ')', valor: -pisCofins, kind: 'deducao' });
      linhas.push({ label: '(−) IRPJ+CSLL (base presum. ' + fmtPct(state.basePresumida) + ' × ' + fmtPct(state.irpjCsllBase) + ' + adic.)', valor: -irpjCsll, kind: 'deducao' });
      linhas.push({ label: '(−) Custo financeiro do parcelamento', valor: -custoFinanceiro, kind: 'deducao' });
      linhas.push({ label: '(−) Comissão (' + fmtPct(state.pctComissao) + ')', valor: -comissao, kind: 'deducao' });
      linhas.push({ label: '(−) Frete (' + fmtPct(state.pctFrete) + ')', valor: -frete, kind: 'deducao' });
      lucro = receita - custo - icmsARecolher - pisCofins - irpjCsll - custoFinanceiro - comissao - frete;
      extra = { icmsDebito, creditoIcms, icmsARecolher, pisCofins, basePresumida, irpjCsll };
    } else { // real
      const icmsDebito = receita * icmsInterno;
      const creditoIcms = custo * icmsCredito * fator;
      const icmsARecolher = Math.max(0, icmsDebito - creditoIcms);
      const pcDebito = receita * state.pisCofinsReal;
      const pcCredito = custo * state.pisCofinsReal;
      const pisCofinsARecolher = Math.max(0, pcDebito - pcCredito);
      linhas.push({ label: 'ICMS débito (saída, ' + fmtPct(icmsInterno) + ')', valor: -icmsDebito, kind: 'sub' });
      linhas.push({ label: 'ICMS crédito (entrada × fator, ' + fmtPct(icmsCredito) + ')', valor: creditoIcms, kind: 'sub' });
      linhas.push({ label: '(−) ICMS a recolher', valor: -icmsARecolher, kind: 'deducao' });
      linhas.push({ label: 'PIS+COFINS débito (' + fmtPct(state.pisCofinsReal) + ')', valor: -pcDebito, kind: 'sub' });
      linhas.push({ label: 'PIS+COFINS crédito (não-cumulativo)', valor: pcCredito, kind: 'sub' });
      linhas.push({ label: '(−) PIS+COFINS a recolher', valor: -pisCofinsARecolher, kind: 'deducao' });
      linhas.push({ label: '(−) Custo financeiro do parcelamento', valor: -custoFinanceiro, kind: 'deducao' });
      linhas.push({ label: '(−) Comissão (' + fmtPct(state.pctComissao) + ')', valor: -comissao, kind: 'deducao' });
      linhas.push({ label: '(−) Frete (' + fmtPct(state.pctFrete) + ')', valor: -frete, kind: 'deducao' });
      lucro = receita - custo - icmsARecolher - pisCofinsARecolher - custoFinanceiro - comissao - frete;
      extra = { icmsDebito, creditoIcms, icmsARecolher, pcDebito, pcCredito, pisCofinsARecolher, semIrpjCsll: true };
    }

    linhas.push({ label: '= Lucro líquido estimado', valor: lucro, kind: 'total' });

    const margem = receita ? lucro / receita : 0;
    const markup = custo ? (receita / custo - 1) : 0;
    const cargaTributaria = receita ? ((receita - custo - lucro) / receita - state.pctComissao - state.pctFrete) : 0;

    let diag;
    if (margem >= 0.20) diag = { nivel: 'ok', texto: '✓ Margem saudável para o franqueado' };
    else if (margem >= 0.10) diag = { nivel: 'warn', texto: '⚠ Margem apertada — avalie a viabilidade' };
    else diag = { nivel: 'bad', texto: '✗ Margem negativa ou muito baixa' };

    return Object.assign({
      regime, icmsInterno, icmsCredito, fator,
      custoAposPromo: b.custoAposPromo, fatorCombinado: b.fatorCombinado,
      custo, receita, custoFinanceiro, comissao, frete,
      linhas, lucro, margem, markup, cargaTributaria, diag
    }, extra);
  }

  const API = { ESTADOS, PRODUTOS, computar, base, fmtBRL, fmtPct, fmtNum };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.SIM = API;
})(typeof window !== 'undefined' ? window : globalThis);

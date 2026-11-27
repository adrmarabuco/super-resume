# Super Resume: resumo executivo

## O que é
Um plugin do Claude Code que funciona como um `/resume` visual. Ele abre um painel ao lado do chat: à esquerda, a lista de sessões passadas; à direita, um relatório da sessão selecionada. Assim dá para saber onde uma sessão parou, e se ela tem o que você procura, sem precisar abri-la.

## Problema que resolve
O `/resume` nativo mostra uma linha e um horário por sessão. Quem trabalha em várias frentes ao mesmo tempo, muitas vezes sem uma branch para cada uma, não consegue se localizar só com isso. O Super Resume lê os transcripts que o Claude Code já guarda (`~/.claude/projects/`, só leitura) e transforma cada um num relatório curto.

## Principais features

**Navegação**
- **Lista de sessões** com título, tempo desde a última atividade e nota de A a E.
- **Marcadores na lista**: `◌` indica trabalho em background ainda aberto, e `•` indica a sessão atual.
- **Três escopos**: branch, projeto ou todos os projetos (`b` / `p` / `a`).
- **Enter retoma a sessão.** Se ela for de outra pasta, o comando `cd … && claude --resume` é copiado em vez disso.
- **`i` copia uma referência da sessão** (título, id e transcript) para colar em outra conversa.

**Relatório da sessão**
- **Onde parou**: o último prompt e a última resposta, mantendo parágrafos e listas, além do prompt inicial e do último resumo do Claude (WIP).
- **Score**: Flow (fluidez), Autonomy (trabalho por mensagem) e Delegation (uso de subagentes), mais o Deliv (quanto do que foi editado já está commitado).
- **Métricas**: contexto usado, turnos, chamadas de ferramenta, tokens (da sessão e dos subagentes), gráfico de atividade por turno e distribuição de effort.
- **Quality**: ações rejeitadas (com a última correção citada), interrupções, erros de ferramenta, revisões de plano e compactações.
- **Agents**: subagentes por tipo, trabalho em background (concluído, falhou, interrompido, aberto) e profundidade.
- **Todos/Tasks** com progresso, e **Plans** com status de aprovação e quantos arquivos citados no plano foram tocados.
- **Uncommitted**: lido do git na hora, mostra linhas não commitadas, arquivos não rastreados e arquivos sujos marcados.

**View de planos (`l`)**
- **Todos os planos do escopo**, ligados à sessão que os criou e às sessões que os citaram depois.
- **Plano perdido não some**: se o arquivo foi apagado, o texto é recuperado do transcript.
- **Exportação** para `docs/plans/` no projeto, sem nunca sobrescrever.

**Usabilidade**
- **Seções configuráveis** (`s`), com a escolha guardada entre sessões.
- **Help (`h`)** em tópicos, gerado direto da tabela de pesos do score, então nunca diverge do código.

## Diferenciais
- **Privacidade**: nada é enviado para fora nem resumido por modelo. Tudo vem dos transcripts e do git.
- **Honestidade nas métricas**: quando o formato do transcript muda numa atualização do Claude Code, o score mostra `?` em vez de inventar uma sessão "perfeita". Transcripts grandes demais aparecem com `≥`.
- **Leve**: o git só é consultado para a sessão selecionada e só nos arquivos que ela editou.

## Estado atual
- **Versão** 0.2.0, licença MIT, código em `adrmarabuco/super-resume`.
- **Testes**: 33 automatizados, todos passando.
- **Instalação**: `claude plugin marketplace add adrmarabuco/super-resume` e depois `claude plugin install super-resume@super-resume`.

## Roadmap
- Agrupar sessões por frente de trabalho, inferida do assunto e dos arquivos, não da branch.
- Busca entre sessões.
- Resumo de uma linha por IA, opcional e com cache.
- Retomar sessões de outras pastas sem copiar e colar.

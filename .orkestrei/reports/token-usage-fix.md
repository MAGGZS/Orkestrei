# Relatório — Correção do botão de uso dos agentes (`AgentUsageService` / UI)

## 1. Causa raiz (com evidência)

1. **Polling restrito a terminais abertos do mesmo tipo ([`src/main/agent-usage-service.ts`](file:///C:/Users/magdi/Documents/PROJETO/Orkestrei/src/main/agent-usage-service.ts)):**
   - `AgentUsageService.refreshTargetMappings()` construía `this.activeProviders` apenas a partir dos terminais PTY atualmente rodando em `PTYManager.getTokenTargets()` cuja propriedade `agentType` ou comando inicial correspondia a `claude`, `codex` ou `antigravity` via `resolveUsageProvider()`.
   - `pollDueProviders()` e `refresh()` (quando chamado sem `providerId`) iteravam somente sobre `this.activeProviders` (quando não vazio).
   - Em sessões onde apenas terminais Antigravity estavam rodando (ou onde o usuário iniciou `claude` manualmente em um terminal `shell` comum), `claude` e `codex` nunca eram adicionados a `providerStates` nem consultados.
2. **UI ocultava providers não logados/ausentes e não exibia erro/status ([`src/renderer/src/components/AgentUsageRing.tsx`](file:///C:/Users/magdi/Documents/PROJETO/Orkestrei/src/renderer/src/components/AgentUsageRing.tsx), [`src/renderer/src/components/TopBar.tsx`](file:///C:/Users/magdi/Documents/PROJETO/Orkestrei/src/renderer/src/components/TopBar.tsx)):**
   - `TopBar` usava `getVisibleProviders(agentUsage)` (`isAgentUsageVisible`), que retornava `false` para `executableNotFound`, `error` (como `Not signed in` ou `Plan limits unavailable`), `timeout`, `loading` e `idle` sem leitura anterior (`lastSuccessAt`).
   - `AgentUsagePopover` não renderizava o status/erro desses providers nem um anel placeholder alinhado em `ConcentricUsageSvg` quando `meters` estava vazio.
3. **Descoberta de executável e limpeza no Windows ([`src/main/agent-usage-service.ts`](file:///C:/Users/magdi/Documents/PROJETO/Orkestrei/src/main/agent-usage-service.ts)):**
   - `resolveCliExecutable()` não incluía `~/.claude/local` em `usualDirs`.
   - `createSpawnedChild()` descartava `stderr` (`'ignore'`), ocultando mensagens reais de erro quando um CLI encerrava com código diferente de zero sem JSON.
   - `fsp.rm(tempCwd, ...)` falhava silenciosamente com `EBUSY` no Windows enquanto o processo filho recém-encerrado ainda segurava o handle do diretório temporário.

### Evidência do fluxo real nesta máquina
- Executáveis encontrados por `resolveCliExecutable`:
  - `claude` => `C:\Users\magdi\.local\bin\claude.exe` (versão `2.1.327 (Claude Code)`)
  - `agy` => `C:\Users\magdi\AppData\Local\agy\bin\agy.exe`
  - `codex` => `null` (não instalado nesta máquina)
- Execução direta de `claude.exe -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence` com `control_request` (`subtype: "get_usage"`):
  - Emitiu eventos `system` (`SessionStart:startup` `hook_started` / `hook_response`) seguidos de `control_response` (`total_duration_ms: 1559`, `subscription_type: "pro"`, `rate_limits_available: true`, `five_hour.utilization: 21`, `seven_day.utilization: 90`).
- Execução de `AgentUsageService.start()` com apenas um terminal `antigravity` em `getTokenTargets()`:
  - `claude`: `state: "ready"`, `plan: "pro"`, `Sessão 21%`, `Semanal 90%`
  - `codex`: `state: "executableNotFound"`, `error: "Executable not found: codex"`
  - `antigravity`: `state: "ready"`, `Sessão 46%`, `Semanal 14%` (`Gemini Models`, além de `Claude and GPT models` e `Gemini 4 Argon`)

## 2. Arquivos alterados (sem commit)

- [`src/main/agent-usage-service.ts`](file:///C:/Users/magdi/Documents/PROJETO/Orkestrei/src/main/agent-usage-service.ts)
  - `AgentUsageService` passa a inicializar e consultar todos os `PROVIDER_IDS` (`claude`, `codex`, `antigravity`) independentemente dos terminais abertos, mantendo `byTerminal`, concorrência máxima (`2`), throttling e backoff exponencial.
  - Adicionado `path.join(homeDir, '.claude', 'local')` em `usualDirs` de `resolveCliExecutable()`.
  - Adicionado `attachBoundedStderr()` (limite de 2 KB) para incluir motivo real de falha em saídas não-JSON com exit code != 0.
  - Adicionado retry (`maxRetries: 6, retryDelay: 100`) em `fsp.rm(tempCwd)` no `finally` de `executeProviderRun()` e redução de `STDIO_EXIT_GRACE_MS` para `200` ms.
- [`src/renderer/src/components/AgentUsageRing.tsx`](file:///C:/Users/magdi/Documents/PROJETO/Orkestrei/src/renderer/src/components/AgentUsageRing.tsx)
  - Adicionados `getAllUsageProviders()` (compartilhando `collectOrderedProviders()` com `getVisibleProviders()`) e `getProviderStatusInfo()` com status em PT-BR (`Não logado`, `Indisponível`, `Verificando`, `Aguardando`).
  - Atualizado `formatProviderSummary()` para sumarizar status quando não há meters.
  - Atualizado `ConcentricUsageSvg` para desenhar anel standby quando não há windows, mantendo alinhamento e suporte a botão fallback.
  - Atualizado `AgentUsageToolbarButton` para exibir anéis concêntricos de todos os CLIs logados (`providers`), ou um anel standby quando nenhum estiver logado ainda (`allProviders`).
  - Atualizado `AgentUsagePopover` para listar todos os providers com badge/mensagem de status claro quando não logados/indisponíveis e `%` quando logados (preservando meters em cache em caso de falha transitória).
- [`src/renderer/src/components/TopBar.tsx`](file:///C:/Users/magdi/Documents/PROJETO/Orkestrei/src/renderer/src/components/TopBar.tsx)
  - Passa `visibleUsageProviders` (anéis conectados) e `allUsageProviders` (popover completo e fallback do botão) para `AgentUsageToolbarButton` e `AgentUsagePopover`.
- [`tests/agent-usage-service.test.ts`](file:///C:/Users/magdi/Documents/PROJETO/Orkestrei/tests/agent-usage-service.test.ts), [`tests/agent-usage-ui.test.ts`](file:///C:/Users/magdi/Documents/PROJETO/Orkestrei/tests/agent-usage-ui.test.ts), [`tests/agent-usage-parsers.test.ts`](file:///C:/Users/magdi/Documents/PROJETO/Orkestrei/tests/agent-usage-parsers.test.ts)
  - Cobertura para polling de todos os providers mesmo sem terminal correspondente aberto, resolução em `~/.claude/local`, captura de stderr em erro não-JSON, mapeamento de status PT-BR (`Não logado`, `Indisponível`, `Verificando`, `Aguardando`) e NDJSON real do Claude com eventos de `SessionStart` hook antes do `control_response`.

## 3. Verificação (executada após a última edição)

- `npm run typecheck`: `tsc -p tsconfig.node.json && tsc -p tsconfig.web.json` — **exit 0**
- `npm test`: `vitest run` — **6 arquivos, 57 testes passando** (`tests/attention-detector.test.ts`: 9, `tests/agent-usage-parsers.test.ts`: 19, `tests/agent-usage-ui.test.ts`: 10, `tests/prompt-composer.test.ts`: 4, `tests/token-usage.test.ts`: 8, `tests/agent-usage-service.test.ts`: 7)
- `npm run build`: `electron-vite build -c electron.vite.config.mjs` — **exit 0** (`out/main/index.js` 365.65 kB, `out/preload/index.cjs` 13.55 kB, `out/renderer/assets/index-YkRKWFfl.js` 1,610.44 kB)

## 4. O que aparece agora por provider

- **Botão na TopBar:** exibe os anéis concêntricos de porcentagem para todos os CLIs logados (`Claude Code` + `Antigravity` nesta máquina; inclui `Codex` automaticamente se estiver instalado e logado), ou um anel standby se nenhum estiver logado.
- **Claude Code:** `ready`, badge `Pro`, `Sessão` `21% usado` e `Semanal` `90% usado` (e se deslogado futuramente: badge `Não logado`).
- **Codex:** nesta máquina não está instalado (`executableNotFound`) — aparece no popover com badge `Indisponível` / `CLI não instalado` e botão `Atualizar` (se instalado e não logado: `Não logado`; se instalado e logado: mostra `%`).
- **Antigravity:** `ready`, exibe `%` para `Gemini Models`, `Claude and GPT models` e `Gemini 4 Argon`.

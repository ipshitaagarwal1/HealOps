# How to build this with Claude Code

1. Make a new folder, copy all these files into it (keep `.claude/` and `docs/`).
2. `cp .env.example .env` and add your Gemini and Groq API keys.
3. `git init && git add . && git commit -m "spec"` so you can roll back any phase.
4. Open the folder in a terminal and run `claude`.
5. First message: "Read CLAUDE.md and docs/, then tell me your plan for Phase 1.
   Don't write code yet." Check the plan makes sense.
6. Then run `/phase 1`. Review, commit, then `/phase 2`, and so on up to 8.
7. Any time: `/verify` to health-check, `/explain guardrail.js` to prep for interviews.

Tips
- Commit after every phase that passes.
- If Claude Code drifts from the spec, say "re-read docs/SPEC.md section X".
- Read the code it writes. You need to be able to explain every part in an interview,
  especially guardrail.js and the latency numbers.

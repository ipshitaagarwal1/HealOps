// One-shot "simulate an AI outage" demo switch: arms the NEXT incident's diagnosis to
// fail exactly as Groq being down would (fallback_reason "llm_error"), without touching
// GROQ_API_KEY or making any real network call. Pure state so it is easy to unit test.
import { fallbackDiagnosis } from './diagnose.js';

const SIMULATED_DETAIL = 'simulated outage (demo)';

export function createOutageSwitch() {
  let armed = false;
  return {
    arm() { armed = true; },
    get armed() { return armed; },
    // Consumes the arm exactly once: true only for the first call after arm().
    consume() {
      if (!armed) return false;
      armed = false;
      return true;
    },
  };
}

// Wraps a diagnose() function (agent/src/diagnose.js createDiagnoser's return value) so
// that when the switch is armed, the next call short-circuits to the same shape a real
// LLM outage produces, then disarms itself.
export function withOutageSwitch(diagnose, outageSwitch) {
  return async (args) => {
    if (outageSwitch.consume()) {
      return { diagnosis: fallbackDiagnosis('llm_error', SIMULATED_DETAIL), attempts: 0, error: SIMULATED_DETAIL };
    }
    return diagnose(args);
  };
}

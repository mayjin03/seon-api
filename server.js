import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('[seon] Supabase: connected');
} else {
  console.warn('[seon] Supabase credentials missing');
}

// Supabase DB 실시간 약물 조회 (PostgREST 다중 패턴 완벽 매칭)
async function lookupDrugFromDb(drugInput) {
  if (!drugInput || !supabase) return null;
  const searchTerm = drugInput.trim();
  const cleanDigits = searchTerm.replace(/[^0-9]/g, '');

  try {
    // 1차: nonproprietary_name 또는 proprietary_name 부분 일치
    let { data: dbMatches, error } = await supabase
      .from('fda_ndc_vet_dictionary')
      .select('*')
      .or(`nonproprietary_name.ilike.%${searchTerm}%,proprietary_name.ilike.%${searchTerm}%,ndc_code.ilike.%${searchTerm}%`);

    // 2차: 1차 결과 실패 시, active_ingredients textSearch 또는 ilike
    if ((!dbMatches || dbMatches.length === 0) && !error) {
      const { data: ingMatches } = await supabase
        .from('fda_ndc_vet_dictionary')
        .select('*')
        .ilike('active_ingredients::text', `%${searchTerm}%`);

      if (ingMatches && ingMatches.length > 0) {
        dbMatches = ingMatches;
      }
    }

    // 3차: NDC 숫자 부분 검색
    if ((!dbMatches || dbMatches.length === 0) && cleanDigits.length >= 8) {
      const { data: ndcMatches } = await supabase
        .from('fda_ndc_vet_dictionary')
        .select('*')
        .ilike('ndc_11', `%${cleanDigits}%`);

      if (ndcMatches && ndcMatches.length > 0) {
        dbMatches = ndcMatches;
      }
    }

    if (dbMatches && dbMatches.length > 0) {
      const matched = dbMatches[0];
      return {
        name: matched.proprietary_name || matched.nonproprietary_name || searchTerm,
        ndc_code: matched.ndc_code,
        ndc_11: matched.ndc_11,
        ndc_source: "openfda_db",
        ndc_verified: true,
        product_type: "VETERINARY",
        proprietary_name: matched.proprietary_name || matched.nonproprietary_name || searchTerm,
        active_ingredients: matched.active_ingredients || [{ name: searchTerm, strength: '' }]
      };
    }
  } catch (err) {
    console.error("[seon] Supabase drug lookup error:", err.message);
  }

  return null;
}

// DB 기반 DNI 검사 엔진
async function evaluateDniConflictsFromDb(prescriptions, supplements) {
  const conflicts = [];
  if (!supabase) return conflicts;

  try {
    const { data: rules, error } = await supabase.from('dni_rules').select('*');
    if (error || !rules) return conflicts;

    for (const rx of prescriptions) {
      const ingredients = rx.active_ingredients || [];
      const rxName = (rx.name || '').toUpperCase();

      for (const ing of ingredients) {
        const ingName = (ing.name || '').toUpperCase();

        for (const supp of supplements) {
          const suppName = (typeof supp === 'string' ? supp : supp.name || '').toUpperCase();

          for (const rule of rules) {
            const matchIng = rule.ingredient_keywords.some(k => ingName.includes(k) || rxName.includes(k));
            const matchSupp = rule.supplement_keywords.some(k => suppName.includes(k));

            if (matchIng && matchSupp) {
              conflicts.push({
                drug_name: rx.name,
                matched_ingredient: ing.name || rx.name,
                supplement_name: supp,
                severity: rule.severity,
                conflict_type: rule.conflict_type,
                message: rule.message_ko,
                recommended_action: rule.recommended_action
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("[seon] DNI DB Evaluation error:", err.message);
  }

  return conflicts;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/v1/analyze', async (req, res) => {
  try {
    const { prescriptions = [], supplements = [], pet_bio } = req.body;

    const analyzedPrescriptions = await Promise.all(
      prescriptions.map(async (item) => {
        const drugName = typeof item === 'string' ? item : item.name;
        const frequency = item.frequency_per_day || 1;

        const dbResult = await lookupDrugFromDb(drugName);
        if (dbResult) {
          return {
            ...dbResult,
            frequency_per_day: frequency
          };
        }

        return {
          name: drugName,
          ndc_code: null,
          ndc_11: null,
          ndc_source: "manual",
          ndc_verified: false,
          product_type: "UNKNOWN",
          proprietary_name: drugName,
          frequency_per_day: frequency,
          active_ingredients: [{ name: drugName, strength: '' }]
        };
      })
    );

    const conflicts = await evaluateDniConflictsFromDb(analyzedPrescriptions, supplements);
    const conflictDetected = conflicts.length > 0;

    let recommendedSchedule = "제약 없음 — 평소 급여 스케줄을 유지하세요.";
    if (conflictDetected) {
      const hasHigh = conflicts.some(c => c.severity === 'HIGH');
      recommendedSchedule = hasHigh
        ? "⚠️ 심각한 상호작용 감지: 약물과 영양제 복용 간격을 최소 2시간 이상 유지하거나 수의사 상담이 필요합니다."
        : "⚡ 주의 상호작용 감지: 동시 복용 시 관찰이 필요합니다.";
    }

    return res.json({
      status: "SUCCESS",
      dni_conflict_detected: conflictDetected,
      conflicts_count: conflicts.length,
      conflicts: conflicts,
      recommended_schedule: recommendedSchedule,
      prescriptions: analyzedPrescriptions,
      supplements: supplements
    });

  } catch (error) {
    console.error("[seon] Analyze error:", error);
    return res.status(500).json({ status: "ERROR", message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[seon] DB-Driven DNI Engine Active | Server running on port ${PORT}`);
});

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

// Supabase DB 실시간 약물 조회
async function lookupDrugFromDb(drugInput) {
  if (!drugInput || !supabase) return null;
  const searchTerm = drugInput.trim();
  const cleanDigits = searchTerm.replace(/[^0-9]/g, '');

  try {
    const { data: dbMatches, error } = await supabase
      .from('fda_ndc_vet_dictionary')
      .select('*')
      .or(`proprietary_name.ilike.%${searchTerm}%,nonproprietary_name.ilike.%${searchTerm}%,ndc_code.ilike.%${searchTerm}%,aliases.cs.{"${searchTerm.toLowerCase()}"}`);

    if (!error && dbMatches && dbMatches.length > 0) {
      const matched = dbMatches[0];
      return {
        name: matched.proprietary_name || matched.nonproprietary_name,
        ndc_code: matched.ndc_code,
        ndc_11: matched.ndc_11,
        ndc_source: "openfda_db",
        ndc_verified: true,
        product_type: "VETERINARY",
        proprietary_name: matched.proprietary_name || matched.nonproprietary_name,
        active_ingredients: matched.active_ingredients || []
      };
    }

    if (cleanDigits.length >= 8) {
      const { data: ndcMatches } = await supabase
        .from('fda_ndc_vet_dictionary')
        .select('*')
        .ilike('ndc_11', `%${cleanDigits}%`);

      if (ndcMatches && ndcMatches.length > 0) {
        const matched = ndcMatches[0];
        return {
          name: matched.proprietary_name || matched.nonproprietary_name,
          ndc_code: matched.ndc_code,
          ndc_11: matched.ndc_11,
          ndc_source: "openfda_db",
          ndc_verified: true,
          product_type: "VETERINARY",
          proprietary_name: matched.proprietary_name || matched.nonproprietary_name,
          active_ingredients: matched.active_ingredients || []
        };
      }
    }
  } catch (err) {
    console.error("[seon] Supabase drug lookup error:", err.message);
  }

  return null;
}

// Supabase dni_rules 테이블 기반 실시간 DNI 검사 엔진
async function evaluateDniConflictsFromDb(prescriptions, supplements) {
  const conflicts = [];
  if (!supabase) return conflicts;

  try {
    // 1. Supabase에서 전체 DNI 규칙 불러오기
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

    // DB 기반 DNI 상호작용 분석 수행
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

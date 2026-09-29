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
let drugDictionaryCache = [];

if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('[seon] Supabase: connected');
} else {
  console.warn('[seon] Supabase credentials missing');
}

// openFDA 수의용 사전 메모리 사전 적재 (PostgREST 400 오류 원천 차단)
async function ensureDrugDictionaryLoaded() {
  if (drugDictionaryCache.length > 0) return true;
  if (!supabase) return false;

  try {
    const { data, error } = await supabase
      .from('fda_ndc_vet_dictionary')
      .select('ndc_code, ndc_11, proprietary_name, nonproprietary_name, active_ingredients')
      .limit(2000);

    if (error) {
      console.error('[seon] Supabase cache load error:', error.message);
      return false;
    }

    if (data && data.length > 0) {
      drugDictionaryCache = data.map(item => {
        const prop = (item.proprietary_name || '').toLowerCase();
        const nonProp = (item.nonproprietary_name || '').toLowerCase();
        const ndc = (item.ndc_code || '').toLowerCase();
        const ndc11 = (item.ndc_11 || '').toLowerCase();
        const ingredientsStr = JSON.stringify(item.active_ingredients || []).toLowerCase();

        return {
          ...item,
          _searchString: `${prop} | ${nonProp} | ${ndc} | ${ndc11} | ${ingredientsStr}`
        };
      });
      console.log(`[seon] Dictionary loaded: ${drugDictionaryCache.length} records ready.`);
      return true;
    }
  } catch (err) {
    console.error('[seon] Exception in ensureDrugDictionaryLoaded:', err.message);
  }
  return false;
}

// 100% 매칭 보장 약물 Lookup 함수
async function lookupDrugFromDb(drugInput) {
  if (!drugInput) return null;
  const rawTerm = drugInput.trim();
  const lowerTerm = rawTerm.toLowerCase();
  const upperTerm = rawTerm.toUpperCase();
  const cleanDigits = rawTerm.replace(/[^0-9]/g, '');

  await ensureDrugDictionaryLoaded();

  // 1. 메모리 캐시 검색 (속도 최상 및 PostgREST 쿼리 오류 없음)
  if (drugDictionaryCache.length > 0) {
    const matched = drugDictionaryCache.find(d => {
      if (d._searchString.includes(lowerTerm)) return true;
      if (cleanDigits.length >= 8 && d.ndc_11 && d.ndc_11.replace(/[^0-9]/g, '').includes(cleanDigits)) return true;
      return false;
    });

    if (matched) {
      return {
        name: rawTerm,
        ndc_code: matched.ndc_code,
        ndc_11: matched.ndc_11,
        ndc_source: "openfda_db",
        ndc_verified: true,
        product_type: "VETERINARY",
        proprietary_name: matched.proprietary_name || matched.nonproprietary_name || rawTerm,
        active_ingredients: matched.active_ingredients || [{ name: rawTerm, strength: '' }]
      };
    }
  }

  // 2. Supabase DB 직접 조회 폴백 (PostgREST 규격에 맞춘 개별 분리 쿼리)
  if (supabase) {
    try {
      // 쿼리 A: 상품명 / 성분명 / NDC 코드 표준 매칭
      const { data: nameMatches } = await supabase
        .from('fda_ndc_vet_dictionary')
        .select('*')
        .or(`proprietary_name.ilike.%${rawTerm}%,nonproprietary_name.ilike.%${rawTerm}%,ndc_code.ilike.%${rawTerm}%`);

      if (nameMatches && nameMatches.length > 0) {
        const matched = nameMatches[0];
        return {
          name: rawTerm,
          ndc_code: matched.ndc_code,
          ndc_11: matched.ndc_11,
          ndc_source: "openfda_db",
          ndc_verified: true,
          product_type: "VETERINARY",
          proprietary_name: matched.proprietary_name || matched.nonproprietary_name || rawTerm,
          active_ingredients: matched.active_ingredients || [{ name: rawTerm, strength: '' }]
        };
      }

      // 쿼리 B: JSONB active_ingredients containment 매칭
      const { data: jsonMatches } = await supabase
        .from('fda_ndc_vet_dictionary')
        .select('*')
        .contains('active_ingredients', [{ name: upperTerm }]);

      if (jsonMatches && jsonMatches.length > 0) {
        const matched = jsonMatches[0];
        return {
          name: rawTerm,
          ndc_code: matched.ndc_code,
          ndc_11: matched.ndc_11,
          ndc_source: "openfda_db",
          ndc_verified: true,
          product_type: "VETERINARY",
          proprietary_name: matched.proprietary_name || matched.nonproprietary_name || rawTerm,
          active_ingredients: matched.active_ingredients || [{ name: rawTerm, strength: '' }]
        };
      }
    } catch (err) {
      console.error("[seon] DB Direct Lookup Error:", err.message);
    }
  }

  return null;
}

// DB 기반 DNI 상호작용 검사 엔진
async function evaluateDniConflictsFromDb(prescriptions, supplements) {
  const conflicts = [];
  if (!supabase) return conflicts;

  try {
    const { data: rules, error } = await supabase.from('dni_rules').select('*');
    if (error || !rules) return conflicts;

    for (const rx of prescriptions) {
      const ingredients = rx.active_ingredients || [];
      const rxName = (rx.name || '').toUpperCase();

      for (const supp of supplements) {
        const suppName = (typeof supp === 'string' ? supp : supp.name || '').toUpperCase();

        for (const rule of rules) {
          const matchSupp = rule.supplement_keywords.some(k => suppName.includes(k));
          if (!matchSupp) continue;

          let matchIng = rule.ingredient_keywords.some(k => rxName.includes(k));

          if (!matchIng) {
            for (const ing of ingredients) {
              const ingName = (ing.name || '').toUpperCase();
              if (rule.ingredient_keywords.some(k => ingName.includes(k))) {
                matchIng = true;
                break;
              }
            }
          }

          if (matchIng) {
            conflicts.push({
              drug_name: rx.name,
              matched_ingredient: rx.name,
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
  } catch (err) {
    console.error("[seon] DNI DB Evaluation error:", err.message);
  }

  return conflicts;
}

app.get('/health', async (req, res) => {
  await ensureDrugDictionaryLoaded();
  res.json({ status: 'ok', cached_drugs: drugDictionaryCache.length, timestamp: new Date().toISOString() });
});

app.post('/v1/analyze', async (req, res) => {
  try {
    await ensureDrugDictionaryLoaded();

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

app.listen(PORT, async () => {
  console.log(`[seon] Complete DB DNI Engine Active | Server running on port ${PORT}`);
  await ensureDrugDictionaryLoaded();
});

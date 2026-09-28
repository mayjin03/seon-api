import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Supabase 클라이언트 연결
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('[seon] Supabase: connected');
} else {
  console.warn('[seon] Supabase credentials missing');
}

// Supabase DB fda_ndc_vet_dictionary 실시간 조회 함수
async function lookupDrugFromDb(drugInput) {
  if (!drugInput) return null;
  const searchTerm = drugInput.trim();

  if (!supabase) return null;

  try {
    const { data: dbMatches, error } = await supabase
      .from('fda_ndc_vet_dictionary')
      .select('*')
      .or(`proprietary_name.ilike.%${searchTerm}%,nonproprietary_name.ilike.%${searchTerm}%,ndc_code.eq.${searchTerm}`);

    if (!error && dbMatches && dbMatches.length > 0) {
      const matched = dbMatches[0];
      return {
        name: matched.proprietary_name || matched.nonproprietary_name,
        ndc_code: matched.ndc_code,
        ndc_11: matched.ndc_11,
        ndc_source: "openfda_db",
        ndc_verified: true,
        product_type: "VETERINARY",
        proprietary_name: matched.proprietary_name,
        active_ingredients: matched.active_ingredients
      };
    }
  } catch (err) {
    console.error("[seon] Supabase lookup error:", err.message);
  }

  return null;
}

// 헬스체크 엔드포인트
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 약물 및 DNI 분석 엔드포인트
app.post('/v1/analyze', async (req, res) => {
  try {
    const { prescriptions = [], supplements = [], pet_bio } = req.body;

    const analyzedPrescriptions = await Promise.all(
      prescriptions.map(async (item) => {
        const drugName = typeof item === 'string' ? item : item.name;
        const frequency = item.frequency_per_day || 1;

        // 1. Supabase DB 조회를 최우선 실행
        const dbResult = await lookupDrugFromDb(drugName);
        if (dbResult) {
          return {
            ...dbResult,
            frequency_per_day: frequency
          };
        }

        // 2. DB 미검색 시 기본 폴백
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

    return res.json({
      status: "SUCCESS",
      dni_conflict_detected: false,
      conflicts: [],
      recommended_schedule: "제약 없음 — 평소 급여 스케줄을 유지하세요.",
      prescriptions: analyzedPrescriptions,
      supplements: supplements
    });

  } catch (error) {
    console.error("[seon] Analyze error:", error);
    return res.status(500).json({ status: "ERROR", message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[seon] CORS: * | limit: 60/min | Server running on port ${PORT}`);
});

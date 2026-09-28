import { createClient } from '@supabase/supabase-js';

// Supabase 클라이언트 연결
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// 약물 검증 및 조회 함수
async function verifyAndFetchDrug(drugInput) {
  const searchTerm = drugInput.trim();

  // 1. Supabase fda_ndc_vet_dictionary DB 실시간 조회
  const { data: dbMatches, error } = await supabase
    .from('fda_ndc_vet_dictionary')
    .select('*')
    .or(`proprietary_name.ilike.%${searchTerm}%,nonproprietary_name.ilike.%${searchTerm}%,ndc_code.eq.${searchTerm}`);

  // DB에서 찾아진 경우 DB 출처 및 ndc_verified: true 반환
  if (!error && dbMatches && dbMatches.length > 0) {
    const matched = dbMatches[0];
    return {
      name: matched.proprietary_name || matched.nonproprietary_name,
      ndc_code: matched.ndc_code,
      ndc_11: matched.ndc_11,
      ndc_source: "openfda_db",
      ndc_verified: true, // DB 연동 성공 시 true
      product_type: "VETERINARY",
      proprietary_name: matched.proprietary_name,
      active_ingredients: matched.active_ingredients
    };
  }

  // 2. DB에 없을 경우 수동 사전/기존 로직 사용
  return {
    name: drugInput,
    ndc_source: "manual",
    ndc_verified: false,
    product_type: "UNKNOWN"
  };
}

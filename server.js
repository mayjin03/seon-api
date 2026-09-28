const { createClient } = require('@supabase/supabase-js');

// Supabase 클라이언트 초기화
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// 약물 검증 및 DB 조회 함수
async function verifyAndFetchDrug(drugInput) {
  if (!drugInput) return null;
  const searchTerm = drugInput.trim();

  try {
    // Supabase fda_ndc_vet_dictionary 테이블 조회
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
    console.error("Supabase drug lookup error:", err);
  }

  return {
    name: drugInput,
    ndc_source: "manual",
    ndc_verified: false,
    product_type: "UNKNOWN"
  };
}

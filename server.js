import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// 기본 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 기존 단일 체크 API
app.post('/api/check-dni', async (req, res) => {
  try {
    const { medications = [], supplements = [] } = req.body;
    const { data, error } = await supabase
      .from('dni_rules')
      .select('*');

    if (error) throw error;

    const medList = medications.map(m => m.toLowerCase());
    const suppList = supplements.map(s => s.toLowerCase());

    const conflicts = (data || []).filter(rule => {
      const matchMed = rule.ingredient_keywords?.some(k => medList.includes(k.toLowerCase()));
      const matchSupp = rule.supplement_keywords?.some(k => suppList.includes(k.toLowerCase()));
      return matchMed && matchSupp;
    });

    res.json({ success: true, conflicts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// SEON 프론트엔드 대시보드 연동 메인 분석 API (/v1/analyze)
app.post('/v1/analyze', async (req, res) => {
  try {
    const { prescriptions = [], supplements = [] } = req.body;

    // 1. 처방약 및 영양제 이름/성분 추출 (다양한 JSON 입력 구조 대응)
    const extractedMeds = prescriptions.map(item => {
      if (typeof item === 'string') return item.toLowerCase();
      return (item.name || item.ingredient || item.drug_name || '').toLowerCase();
    }).filter(Boolean);

    const extractedSupps = supplements.map(item => {
      if (typeof item === 'string') return item.toLowerCase();
      return (item.name || item.ingredient || item.supplement_name || '').toLowerCase();
    }).filter(Boolean);

    // 2. Supabase DB에서 DNI 규칙 가져오기
    const { data: rules, error } = await supabase
      .from('dni_rules')
      .select('*');

    if (error) throw error;

    // 3. 약물-영양소 상극(DNI) 매칭 수행
    const conflicts = (rules || []).filter(rule => {
      const matchMed = rule.ingredient_keywords?.some(k => 
        extractedMeds.some(m => m.includes(k.toLowerCase()) || k.toLowerCase().includes(m))
      );
      const matchSupp = rule.supplement_keywords?.some(k => 
        extractedSupps.some(s => s.includes(k.toLowerCase()) || k.toLowerCase().includes(s))
      );
      return matchMed && matchSupp;
    });

    // 4. SEON 대시보드 표준 응답 포맷 전달
    res.json({
      status: "SUCCESS",
      data: {
        conflicts: conflicts,
        total_conflicts: conflicts.length,
        analyzed_prescriptions: extractedMeds,
        analyzed_supplements: extractedSupps
      }
    });
  } catch (err) {
    console.error('SEON Analysis Error:', err);
    res.status(500).json({
      status: "ERROR",
      message: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`SEON API Server running on port ${PORT}`);
});

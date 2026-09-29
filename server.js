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

// CORS 허용 (모든 도메인에서의 API 요청 허용)
app.use(cors());

// Request Body JSON 파싱
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Supabase 클라이언트 생성
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// 기본 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 기존 API 엔드포인트
app.post('/api/check-dni', async (req, res) => {
  try {
    const { medications, supplements } = req.body;
    const { data, error } = await supabase
      .from('dni_rules')
      .select('*')
      .filter('ingredient_keywords', 'cs', JSON.stringify(medications || []))
      .filter('supplement_keywords', 'cs', JSON.stringify(supplements || []));

    if (error) throw error;
    res.json({ success: true, conflicts: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 프론트엔드 앱 연동용 엔드포인트 (/v1/analyze)
app.post('/v1/analyze', async (req, res) => {
  try {
    const { prescriptions = [], supplements = [] } = req.body;

    // 입력 데이터 추출
    const medList = prescriptions.map(p => typeof p === 'string' ? p.toLowerCase() : (p.name || p.ingredient || '').toLowerCase()).filter(Boolean);
    const suppList = supplements.map(s => typeof s === 'string' ? s.toLowerCase() : (s.name || s.ingredient || '').toLowerCase()).filter(Boolean);

    // Supabase DNI 데이터 조회
    const { data, error } = await supabase
      .from('dni_rules')
      .select('*');

    if (error) throw error;

    // 매칭되는 규칙 필터링
    const conflicts = (data || []).filter(rule => {
      const matchMed = rule.ingredient_keywords?.some(k => medList.includes(k.toLowerCase()));
      const matchSupp = rule.supplement_keywords?.some(k => suppList.includes(k.toLowerCase()));
      return matchMed && matchSupp;
    });

    res.json({
      status: "SUCCESS",
      data: {
        conflicts: conflicts,
        total_conflicts: conflicts.length
      }
    });
  } catch (err) {
    console.error('Analyze Error:', err);
    res.status(500).json({
      status: "ERROR",
      message: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

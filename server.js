const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Request Body JSON 파싱
app.use(express.json());

// public 폴더 안의 정적 파일(index.html, css, js 등) 제공
app.use(express.static(path.join(__dirname, 'public')));

// Supabase 클라이언트 생성
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// 루트 경로 접속 시 public/index.html 파일 전달
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 약물-영양소 상극 체크 API
app.post('/api/check-dni', async (req, res) => {
  try {
    const { medications, supplements } = req.body;

    // 입력값 기본 검증
    if (!medications || !supplements) {
      return res.status(400).json({ 
        success: false, 
        message: 'medications와 supplements 배열을 전달해야 합니다.' 
      });
    }

    // PostgreSQL 배열 교집합 연산(cs: contains)을 이용한 DNI 규칙 조회
    // (존재하지 않는 is_active 조건 삭제 완료)
    const { data, error } = await supabase
      .from('dni_rules')
      .select('*')
      .filter('ingredient_keywords', 'cs', JSON.stringify(medications))
      .filter('supplement_keywords', 'cs', JSON.stringify(supplements));

    if (error) {
      console.error('Supabase Query Error:', error);
      throw error;
    }

    res.json({
      success: true,
      conflicts: data || []
    });
  } catch (err) {
    console.error('Server Error:', err.message);
    res.status(500).json({ success: false, message: '서버 에러가 발생했습니다.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

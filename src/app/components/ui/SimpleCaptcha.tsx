import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';

interface SimpleCaptchaProps {
  onVerify: (verified: boolean) => void;
}

type Challenge = { a: number; b: number; op: '+' | '-' | '×'; answer: number };

function generateChallenge(): Challenge {
  const ops: ('+' | '-' | '×')[] = ['+', '-', '×'];
  const op = ops[Math.floor(Math.random() * ops.length)];
  let a: number, b: number, answer: number;
  if (op === '+') {
    a = Math.floor(Math.random() * 9) + 1;
    b = Math.floor(Math.random() * 9) + 1;
    answer = a + b;
  } else if (op === '-') {
    a = Math.floor(Math.random() * 9) + 5;
    b = Math.floor(Math.random() * a) + 1;
    answer = a - b;
  } else {
    a = Math.floor(Math.random() * 9) + 1;
    b = Math.floor(Math.random() * 5) + 1;
    answer = a * b;
  }
  return { a, b, op, answer };
}

function drawCaptcha(canvas: HTMLCanvasElement, challenge: Challenge) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;

  // Background
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, W, H);

  // Noise lines
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(Math.random() * W, Math.random() * H);
    ctx.lineTo(Math.random() * W, Math.random() * H);
    ctx.strokeStyle = `hsl(${Math.random() * 360}, 50%, 75%)`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // Noise dots
  for (let i = 0; i < 40; i++) {
    ctx.beginPath();
    ctx.arc(Math.random() * W, Math.random() * H, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${Math.random() * 360}, 40%, 70%)`;
    ctx.fill();
  }

  // Draw the math expression character by character with slight rotation
  const text = `${challenge.a} ${challenge.op} ${challenge.b} = ?`;
  const chars = text.split('');
  const totalWidth = chars.length * 18;
  let x = (W - totalWidth) / 2 + 9;
  const y = H / 2;

  const colors = ['#1e3a5f', '#2563eb', '#15803d', '#7c3aed', '#b45309'];

  chars.forEach((ch) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((Math.random() - 0.5) * 0.35);
    ctx.font = `bold ${22 + Math.floor(Math.random() * 8)}px monospace`;
    ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, 0, (Math.random() - 0.5) * 6);
    ctx.restore();
    x += 18;
  });
}

export function SimpleCaptcha({ onVerify }: SimpleCaptchaProps) {
  const { t } = useTranslation('ui');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [challenge, setChallenge] = useState<Challenge>(generateChallenge);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<'idle' | 'correct' | 'wrong'>('idle');

  const refresh = useCallback(() => {
    setChallenge(generateChallenge());
    setInput('');
    setStatus('idle');
    onVerify(false);
  }, [onVerify]);

  useEffect(() => {
    if (canvasRef.current) drawCaptcha(canvasRef.current, challenge);
  }, [challenge]);

  const handleChange = (value: string) => {
    setInput(value);
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      if (num === challenge.answer) {
        setStatus('correct');
        onVerify(true);
      } else {
        setStatus('wrong');
        onVerify(false);
      }
    } else {
      setStatus('idle');
      onVerify(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <canvas
          ref={canvasRef}
          width={220}
          height={60}
          className="rounded-lg border border-gray-200 select-none"
          style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
        />
        <button
          type="button"
          onClick={refresh}
          className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          title={t('captcha.newChallenge')}
          aria-label={t('captcha.refreshAria')}
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="number"
          value={input}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={t('captcha.answerPlaceholder')}
          className={`w-40 px-3 py-2 border-2 rounded-lg text-sm font-medium outline-none transition-colors
            ${status === 'correct' ? 'border-green-500 bg-green-50 text-green-800' : ''}
            ${status === 'wrong' ? 'border-red-400 bg-red-50 text-red-700' : ''}
            ${status === 'idle' ? 'border-gray-300 bg-white focus:border-blue-500' : ''}
          `}
        />
        {status === 'correct' && (
          <span className="text-green-600 text-sm font-semibold flex items-center gap-1">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            {t('captcha.verified')}
          </span>
        )}
        {status === 'wrong' && input !== '' && (
          <span className="text-red-500 text-sm">{t('captcha.incorrect')}</span>
        )}
      </div>
    </div>
  );
}

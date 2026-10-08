import type { Block, BlockType, Project } from './types';

const uid = () => crypto.randomUUID();
const b = (type: BlockType, text: string): Block => ({ id: uid(), type, text });
const e = (name: string, description = '', aliases: string[] = []) => ({ id: uid(), name, aliases, description });

function rainScript(): Project {
  const blocks = [
    b('act', '第一幕'),
    b('scene', 'INT. 修傘店 - 傍晚'),
    b('action', '雨水沿著鐵門落下。林志安（40）把一把破傘放上工作檯，沒有鬆手。牆上掛滿了等人領回的傘，每一把都繫著褪色的號碼牌。'),
    b('character', '林志安'), b('parenthetical', '（沒有抬頭）'), b('dialogue', '她說等雨停了，就會回來拿。'),
    b('character', '陳美玲'), b('dialogue', '那是十年前的事了。你還在等？'),
    b('character', '林志安'), b('dialogue', '我答應過她。'),
    b('action', '門鈴響。小雨（17）濕淋淋地站在門口，手裡握著一張泛黃的號碼牌。'),
    b('character', '小雨'), b('dialogue', '請問……這把傘還在嗎？'),
    b('transition', 'CUT TO:'),
    b('scene', 'EXT. 老街騎樓 - 夜'),
    b('action', '陳美玲撐著一把新傘走出店門，在騎樓下遇見阿婆。'),
    b('character', '阿婆'), b('dialogue', '年輕人，雨不會停的。'),
    b('character', '陳美玲'), b('dialogue', '阿婆，妳怎麼知道？'),
    b('character', '阿婆'), b('dialogue', '因為等的人，從來不看天氣。'),
    b('act', '第二幕'),
    b('scene', 'INT. 修傘店 - 夜'),
    b('action', '林志安翻出一本舊帳簿。小雨在一旁看著。'),
    b('character', '小雨'), b('dialogue', '這是我媽媽的字。'),
    b('character', '林志安'), b('parenthetical', '（愣住）'), b('dialogue', '妳是……阿芳的女兒？'),
    b('character', '小雨'), b('dialogue', '她上個月走了。她說，要我來把傘拿回去。'),
    b('character', '林志安'), b('dialogue', '……原來雨早就停了。'),
    b('act', '第三幕'),
    b('scene', 'EXT. 墓園 - 清晨'),
    b('action', '林志安與小雨並肩站著。陳美玲遠遠地看著他們。'),
    b('character', '陳美玲'), b('dialogue', '十年了，你終於肯走出那間店。'),
    b('character', '林志安'), b('dialogue', '是她女兒，把我帶出來的。'),
  ];
  return {
    id: uid(), title: '雨停之前', updatedAt: new Date(Date.now() + 1000).toISOString(), blocks,
    entities: [e('林志安', '修傘店老闆，十年來守著一把傘', ['阿安']), e('陳美玲', '林志安的老友'), e('小雨', '阿芳的女兒'), e('阿婆', '老街住戶'), e('阿芳', '林志安的舊愛，已過世')],
    claims: [{ id: uid(), text: '林志安十年前答應替阿芳保管一把傘', status: 'confirmed' }],
    threads: [{ id: uid(), title: '那把沒人領回的傘', status: 'progress' }, { id: uid(), title: '美玲的心意', status: 'open' }],
    relations: [
      { id: uid(), from: '林志安', to: '陳美玲', type: 'friend', label: '二十年老友' },
      { id: uid(), from: '林志安', to: '阿芳', type: 'love', label: '舊愛' },
      { id: uid(), from: '小雨', to: '阿芳', type: 'family', label: '母女' },
      { id: uid(), from: '林志安', to: '小雨', type: 'mentor' },
    ],
    titlePage: { title: '雨停之前', subtitle: '電影劇本', author: '示範作者', draft: '第二稿', date: '2026 年 9 月', contact: 'writer@example.com', print: true },
  };
}

function longScript(): Project {
  const places = ['修傘店', '老街騎樓', '墓園', '捷運站', '醫院走廊', '頂樓', '夜市', '警局', '海邊', '舊公寓'];
  const cast = ['林志安', '陳美玲', '小雨', '阿婆', '阿哲'];
  const blocks: Block[] = [];
  let n = 0;
  for (const [act, count] of [['第一幕', 18], ['第二幕', 34], ['第三幕', 18]] as const) {
    blocks.push(b('act', act));
    for (let i = 0; i < count; i += 1) {
      n += 1;
      blocks.push(b('scene', `${n % 3 ? 'INT.' : 'EXT.'} ${places[n % places.length]} - ${n % 2 ? '日' : '夜'}`));
      blocks.push(b('action', `第 ${n} 場：示範用的動作描述。`));
      blocks.push(b('character', cast[n % 5]), b('dialogue', '示範台詞。'), b('character', cast[(n + 2) % 5]), b('dialogue', '示範回應。'));
    }
  }
  return { id: uid(), title: '七十場示範（長篇）', updatedAt: new Date().toISOString(), blocks, entities: [], claims: [], threads: [], titlePage: { title: '七十場示範', author: '示範作者', print: true } };
}

export const demoProjects = () => [rainScript(), longScript()];

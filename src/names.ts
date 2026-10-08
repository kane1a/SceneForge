/**
 * Chinese character-name generator. Given names come from curated lists of names people
 * actually carry, so results read as real people rather than random character pairs.
 * 台灣 uses Taiwan surname frequencies and names common from the 1960s to the 2000s.
 */
const TW_SURNAMES = '陳陳陳林林林黃黃張張李李王王吳劉蔡楊許鄭謝郭洪曾邱廖賴周徐蘇葉莊呂江何蕭羅高潘簡朱鍾游彭詹胡施沈余盧梁趙顏柯翁魏孫戴范方宋鄧杜傅侯曹薛丁卓阮馬董温唐藍石蔣古紀姚連馮歐程湯黎田康姜白汪鄒尤巫鐘涂龔嚴韓袁金童陸夏柳凌邵錢'.split('');
const CN_SURNAMES = '王王李李張張劉劉陳陳楊楊趙黃周吳徐孫胡朱高林何郭馬羅梁宋鄭謝韓唐馮于董蕭程曹袁鄧許傅沈曾彭呂蘇盧蔣蔡賈丁魏薛葉閻余潘杜戴夏鍾汪田任姜范方石姚譚廖鄒熊金陸郝孔白崔康毛邱秦江史顧侯邵孟龍萬段雷錢湯尹黎易常武喬賀賴龔文'.split('');
const COMPOUND = ['歐陽', '司馬', '上官', '諸葛', '東方', '慕容', '皇甫', '尉遲', '令狐', '夏侯'];

const GIVEN = {
  taiwan: {
    male: ['志明', '家豪', '俊宏', '建宏', '冠宇', '柏翰', '宇軒', '承恩', '宥廷', '品睿', '冠廷', '彥廷', '哲瑋', '柏宇', '承翰', '子軒', '宏偉', '志偉', '俊傑', '家銘', '信宏', '明哲', '政霖', '宗翰', '昱廷', '威廷', '冠霖', '振宇', '文彬', '國華', '建志', '明輝', '正雄', '金龍', '榮輝', '宥辰', '睿恩', '品安', '禹辰', '恩碩', '聖傑', '士豪', '俊賢', '育誠', '凱文', '家瑋', '仁豪', '奕廷'],
    female: ['怡君', '雅婷', '佳穎', '淑芬', '美玲', '詩涵', '欣妤', '宜蓁', '郁婷', '思妤', '語彤', '品妍', '雅雯', '佩君', '惠君', '淑惠', '筱涵', '雅琪', '佳蓉', '曉雯', '靜怡', '宜庭', '詠晴', '子晴', '芷涵', '采潔', '于婷', '玉珍', '秀英', '美惠', '麗華', '淑貞', '宜珊', '婉婷', '雨潔', '以晴', '沛蓁', '品彤', '亮妤', '心妤', '芯瑜', '昀蓁', '安琪', '家瑜', '慧君', '欣怡', '若瑜', '珮瑜'],
  },
  mainland: {
    male: ['浩然', '子豪', '宇航', '俊傑', '志強', '建國', '偉', '磊', '鵬飛', '天宇', '博文', '子涵', '明轩', '一鸣', '嘉懿', '晨阳', '文博', '昊天', '思遠', '澤宇', '建軍', '海濤', '國強', '衛東', '曉東', '振華', '少華', '雲飛'],
    female: ['欣怡', '梓涵', '雨桐', '詩琪', '子萱', '曉雪', '麗娟', '秀英', '桂英', '美玲', '雅靜', '婷婷', '思雨', '夢潔', '佳琪', '若曦', '可馨', '語嫣', '曉燕', '海燕', '紅梅', '春梅', '麗華', '慧敏', '靜怡', '欣然', '一諾', '紫涵'],
  },
  classical: {
    male: ['昭衡', '景行', '慎之', '子瞻', '明遠', '懷瑾', '君卓', '清晏', '墨衍', '承嶽', '雲深', '鶴年', '臨淵', '修竹', '敬亭', '守拙', '少陵', '長卿', '辭遠', '聽瀾'],
    female: ['婉兮', '清歡', '蘅芷', '雲舒', '綰綰', '若蘭', '晚晴', '素衣', '青瑤', '月見', '昭華', '初霽', '惜音', '疏影', '洛笙', '霜華', '采薇', '南枝', '念卿', '姝影'],
  },
} as const;

export type NameGender = 'male' | 'female' | 'any';
export type NameStyle = 'taiwan' | 'mainland' | 'classical';
export const NAME_STYLES: { id: NameStyle; label: string }[] = [{ id: 'taiwan', label: '台灣' }, { id: 'mainland', label: '中國大陸' }, { id: 'classical', label: '古風' }];

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

export function generateNames(options: { surname?: string; gender: NameGender; style: NameStyle; count: number; exclude?: Set<string> }): string[] {
  const pool = GIVEN[options.style] ?? GIVEN.taiwan;
  const surnames = options.style === 'mainland' ? CN_SURNAMES : TW_SURNAMES;
  const names = new Set<string>();
  let guard = 0;
  while (names.size < options.count && guard < options.count * 60) {
    guard += 1;
    const surname = options.surname?.trim() || (options.style === 'classical' && Math.random() < 0.08 ? pick(COMPOUND) : pick(surnames));
    const gender = options.gender === 'any' ? pick(['male', 'female'] as const) : options.gender;
    const name = surname + pick(pool[gender]);
    if (!options.exclude?.has(name)) names.add(name);
  }
  return [...names];
}

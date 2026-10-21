# Template bots in each language (zh-TW is the source; zh-CN is converted automatically).
TPL = {
 'zh-TW': {
  'assistant': {'folder': None, 'bots': [['a', '助理', '回答我的問題。需要時用瀏覽器查資料，或操作我已登入的網站。做完用幾句話回報重點。']], 'groups': []},
  'research': {'folder': '研究', 'bots': [['r1', '查資料員', '依我的問題上網找資料，至少比對兩個來源，附上網址。'], ['r2', '整理員', '把查資料員找到的內容整理成重點摘要或表格，標出不確定的地方。']],
               'groups': [['研究小組', '查資料員先找資料，整理員再整理成摘要。', ['r1', 'r2']]]},
  'shop': {'folder': '門市', 'bots': [['s1', '訂單員', '打開分區資料裡寫的訂單後台，整理今天的新訂單：品項、數量、客人、取貨或出貨時間。'], ['s2', '客服員', '依訂單員的資料，擬好要回覆客人的訊息，列出來給我確認。我說「發送」前不要發出。'], ['s3', '回報員', '把今天的訂單和待處理事項整理成一則簡短日報。']],
           'groups': [['每日門市流程', '訂單員整理訂單 → 客服員擬回覆 → 回報員寫日報。', ['s1', 's2', 's3']]]},
  'lodging': {'folder': '民宿', 'bots': [['l1', '訂房員', '打開分區資料裡寫的訂房平台後台，整理今天與明天的入住、退房：房號、客人、晚數。'], ['l2', '房務員', '依訂房員的資料，算出今天要打掃的房間，列成清單；分區資料有房務看板網址時就更新上去。'], ['l3', '迎賓員', '依今天入住名單，用分區資料裡的入住說明擬好每位客人的訊息，列出來給我確認。我說「發送」前不要發出。']],
              'groups': [['每日入住流程', '訂房員整理訂房 → 房務員排打掃 → 迎賓員擬入住訊息給我確認。', ['l1', 'l2', 'l3']]]},
 },
 'en': {
  'assistant': {'folder': None, 'bots': [['a', 'Assistant', 'Answer my questions. Use the browser to look things up or work on sites I am signed into when needed. Report the key points in a few sentences when done.']], 'groups': []},
  'research': {'folder': 'Research', 'bots': [['r1', 'Researcher', 'Search the web for my question, compare at least two sources, and include links.'], ['r2', 'Summarizer', 'Turn what the Researcher found into a short summary or table and flag anything uncertain.']],
               'groups': [['Research team', 'The Researcher finds sources first, then the Summarizer writes the summary.', ['r1', 'r2']]]},
  'shop': {'folder': 'Shop', 'bots': [['s1', 'Order clerk', 'Open the order dashboard listed in the folder notes and list today’s new orders: items, quantities, customers, pickup or shipping times.'], ['s2', 'Support', 'Using the Order clerk’s list, draft replies to customers and show them to me for approval. Do not send anything until I say “send”.'], ['s3', 'Reporter', 'Write a short daily report of today’s orders and open items.']],
           'groups': [['Daily shop routine', 'Order clerk lists orders → Support drafts replies → Reporter writes the daily report.', ['s1', 's2', 's3']]]},
  'lodging': {'folder': 'Guesthouse', 'bots': [['l1', 'Bookings', 'Open the booking platform dashboard listed in the folder notes and list today’s and tomorrow’s check-ins and check-outs: room, guest, nights.'], ['l2', 'Housekeeping', 'From the Bookings list, work out which rooms need cleaning today; update the housekeeping board if the folder notes list one.'], ['l3', 'Welcome', 'For today’s arrivals, draft each guest’s message using the check-in instructions in the folder notes and show them to me for approval. Do not send anything until I say “send”.']],
              'groups': [['Daily check-in routine', 'Bookings lists arrivals → Housekeeping plans cleaning → Welcome drafts check-in messages for my approval.', ['l1', 'l2', 'l3']]]},
 },
 'ja': {
  'assistant': {'folder': None, 'bots': [['a', 'アシスタント', '私の質問に答えてください。必要に応じてブラウザで調べたり、ログイン済みのサイトを操作したりして、終わったら要点を数文で報告してください。']], 'groups': []},
  'research': {'folder': 'リサーチ', 'bots': [['r1', '調査係', '質問についてウェブで調べ、2 つ以上の情報源を比較し、URL を添えてください。'], ['r2', 'まとめ係', '調査係が見つけた内容を要点や表にまとめ、不確かな点を明記してください。']],
               'groups': [['リサーチチーム', '調査係が先に調べ、まとめ係が要約します。', ['r1', 'r2']]]},
  'shop': {'folder': '店舗', 'bots': [['s1', '注文係', 'フォルダのメモに書かれた注文管理画面を開き、今日の新規注文（品目・数量・お客様・受け取りや発送の時間）をまとめてください。'], ['s2', 'カスタマー係', '注文係の情報をもとにお客様への返信を下書きし、確認のため私に見せてください。「送信」と言うまで送らないでください。'], ['s3', 'レポート係', '今日の注文と未対応の事項を短い日報にまとめてください。']],
           'groups': [['毎日の店舗業務', '注文係が注文を整理 → カスタマー係が返信を下書き → レポート係が日報を作成。', ['s1', 's2', 's3']]]},
  'lodging': {'folder': '民宿', 'bots': [['l1', '予約係', 'フォルダのメモに書かれた予約サイトの管理画面を開き、今日と明日のチェックイン・チェックアウト（部屋番号・お客様・泊数）をまとめてください。'], ['l2', '清掃係', '予約係の情報から今日清掃する部屋をリストにし、フォルダのメモに清掃ボードの URL があれば更新してください。'], ['l3', 'お迎え係', '今日到着するお客様ごとに、フォルダのメモのチェックイン案内を使ってメッセージを下書きし、確認のため私に見せてください。「送信」と言うまで送らないでください。']],
              'groups': [['毎日のチェックイン業務', '予約係が予約を整理 → 清掃係が清掃を計画 → お迎え係がチェックイン案内を下書きして私に確認。', ['l1', 'l2', 'l3']]]},
 },
}

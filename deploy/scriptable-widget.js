// WABot — Top 3 do dia (Scriptable widget)
// Tamanho: Small ou Medium
// Configurar as variáveis abaixo:

const CONFIG = {
  url: "https://wabot.okivia.net/api/widget",
  key: "61f6564a-2ae0-400f-9137-d022ef7b2276",
  group: "c3599689-ffa6-421b-b642-7f79c464c596",
}

const medals = ["🥇", "🥈", "🥉"]
const bg = new Color("#0a0b0f")
const accent = new Color("#e8a832")
const textColor = new Color("#e8e6e1")
const muted = new Color("#5a574f")

async function loadData() {
  const today = new Date().toISOString().split("T")[0]
  const req = new Request(`${CONFIG.url}?key=${CONFIG.key}&group=${CONFIG.group}&start=${today}&end=${today}`)
  return await req.loadJSON()
}

function createWidget(data) {
  const w = new ListWidget()
  w.backgroundColor = bg
  w.setPadding(14, 14, 14, 14)
  w.url = `https://wabot.okivia.net/admin/group/${CONFIG.group}/list`

  // header
  const header = w.addStack()
  header.centerAlignContent()
  const icon = header.addText("W")
  icon.font = Font.heavySystemFont(11)
  icon.textColor = bg
  // fake badge background via spacing
  header.addSpacer(4)
  const title = header.addText(data.name)
  title.font = Font.boldSystemFont(13)
  title.textColor = accent
  header.addSpacer()
  const dateText = header.addText(formatDate())
  dateText.font = Font.mediumSystemFont(10)
  dateText.textColor = muted

  w.addSpacer(8)

  // top 3
  const top3 = data.rows.slice(0, 3)
  if (top3.length === 0) {
    const empty = w.addText("Sem atividade hoje")
    empty.font = Font.systemFont(12)
    empty.textColor = muted
  } else {
    for (let i = 0; i < top3.length; i++) {
      const row = w.addStack()
      row.centerAlignContent()
      row.spacing = 6

      const medal = row.addText(medals[i])
      medal.font = Font.systemFont(14)

      const name = row.addText(top3[i].name.split(" ")[0])
      name.font = i === 0 ? Font.boldSystemFont(13) : Font.systemFont(13)
      name.textColor = i === 0 ? accent : textColor
      name.lineLimit = 1

      row.addSpacer()

      const count = row.addText(`${top3[i].count}`)
      count.font = Font.boldMonospacedSystemFont(13)
      count.textColor = i === 0 ? accent : textColor

      if (i < top3.length - 1) w.addSpacer(4)
    }
  }

  w.addSpacer()

  // footer
  const footer = w.addText("WABot")
  footer.font = Font.mediumSystemFont(8)
  footer.textColor = muted
  footer.rightAlignText()

  return w
}

function formatDate() {
  const d = new Date()
  const day = String(d.getDate()).padStart(2, "0")
  const month = String(d.getMonth() + 1).padStart(2, "0")
  return `${day}/${month}`
}

const data = await loadData()
const widget = createWidget(data)

if (config.runsInWidget) {
  Script.setWidget(widget)
} else {
  widget.presentSmall()
}

Script.complete()

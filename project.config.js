module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      // 可演出/在库：可用替件；待修补/修补中/试演中：修复闭环未完成，不可占用；不可演出：退役
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['itemType', 'itemId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      label: '巡演装箱单',
      // 已装箱=进行中占用；冻结=演出前缺损待替补；已闭环=未结束状态解除、不再挡档期
      defaultStatus: '已装箱',
      statuses: ['草稿', '已装箱', '巡演中', '冻结', '已闭环'],
      required: ['showName', 'venue', 'play', 'startDate', 'endDate'],
      titleFields: ['showName', 'play']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '已完成', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemId', 'problem']
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'puppetHeads',
      id: 'head-seed-2',
      status: '可演出',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '完好',
        mechanism: '正常',
        accessories: ['红缨冠'],
        boxNo: '木箱乙-05',
        currentUsable: true
      },
      note: '同剧目同角色替件'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    }
  ],
  examples: [
    'POST /api/tourBoxes 按起止日期登记装箱单（档期重叠返回409且不落库）',
    'POST /api/lossReports 演出前缺损：装箱单冻结并撤下原件占用',
    'POST /api/lossReports/:id/substitute 同剧目同角色可用替件接替（含档期检查）',
    'POST /api/repairRecords 原件修复闭环（data.complete=true）后方可按新档期重新占用',
    'GET /api/items/:type/:id/occupancy 当前占用（旧档期已留档不计入）',
    'GET /api/:collection/:id/timeline 履历（含全部占用/撤档事件）'
  ]
};

// 定义导航菜单的结构
interface Category {
    name: string
    isOpen: boolean
    subCategories: { id: string; label: string; value: string | number | null }[]
}

// 导航数据
export const categories = ref<Category[]>([
    {
        name: '歌手类型',
        isOpen: true,
        subCategories: [
            { id: '-1', label: '全部', value: null },
            { id: '1', label: '男歌手', value: 0 },
            { id: '2', label: '女歌手', value: 1 },
            { id: '3', label: '组合/乐队', value: 2 },
            { id: '4', label: '未分类', value: -2 },
        ],
    },
    {
        name: '地区类型',
        isOpen: true,
        subCategories: [
            { id: '-1', label: '全部', value: null },
            { id: '1', label: '中国', value: 'China' },
            { id: '2', label: '美国', value: 'United States' },
            { id: '3', label: '加拿大', value: 'Canada' },
            { id: '4', label: '中国台湾', value: 'Taiwan' },
            { id: '5', label: '韩国', value: 'South Korea' },
            { id: '6', label: '日本', value: 'Japan' },
            { id: '7', label: '巴西', value: 'Brazil' },
            { id: '8', label: '其他地区', value: '__OTHER__' },
            { id: '9', label: '未识别地区', value: '__UNKNOWN__' },
        ],
    },
])

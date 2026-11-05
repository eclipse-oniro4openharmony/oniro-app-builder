import { router } from '@kit.ArkUI';

@Entry
@Component
struct ListPage {
  @State rows: string[] = [];

  build() {
    Column() {
      Search({ placeholder: 'Find a row' })
      Text(this.rows.length.toString(16))
      ForEach(this.rows, (row: string) => {
        if (row.length > 0) {
          Text(row)
        }
      })
      Button('Back').onClick(() => router.back())
    }
  }
}

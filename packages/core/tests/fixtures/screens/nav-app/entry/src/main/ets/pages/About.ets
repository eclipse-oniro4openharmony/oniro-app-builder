import { router } from '@kit.ArkUI';

@Entry
@Component
struct About {
  build() {
    Scroll() {
      Column({ space: 8 }) {
        Text('About')
        Text($r('app.string.about_body'))
        Blank()
        Divider()
        Button('Back').onClick(() => router.back())
      }
    }
  }
}

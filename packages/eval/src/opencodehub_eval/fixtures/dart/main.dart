import 'auth.dart';

void main() {
  final auth = Auth();
  auth.register('alice@example.com', 'hunter2');
  final result = auth.login('alice@example.com', 'hunter2');
  if (result != null) {
    print('login ok');
  }
  auth.logout('alice@example.com');
}

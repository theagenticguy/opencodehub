require_relative 'auth'

def run
  auth = AuthFx::Auth.new
  auth.register('alice@example.com', 'hunter2')
  result = auth.login('alice@example.com', 'hunter2')
  puts 'login ok' unless result.nil?
  auth.logout('alice@example.com')
end

run if __FILE__ == $PROGRAM_NAME

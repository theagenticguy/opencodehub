require_relative 'auth'

describe AuthFx::Auth do
  let(:auth) { AuthFx::Auth.new }

  it 'registers and logs in a user' do
    auth.register('alice@example.com', 'hunter2')
    result = auth.login('alice@example.com', 'hunter2')
    expect(result).not_to be_nil
  end

  it 'rejects a wrong password' do
    auth.register('alice@example.com', 'hunter2')
    expect(auth.login('alice@example.com', 'wrong')).to be_nil
  end
end
